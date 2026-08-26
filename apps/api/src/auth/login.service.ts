import { isIP } from 'node:net';
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

/**
 * authn-authz-10, and the reason the durable lock does not undo A1-01.
 *
 * `users.lockedUntil` is now armed on the NORMAL path — five wrong passwords
 * write it, not just five wrong passwords during a Redis outage. On its own
 * that is a bare-account lock, i.e. exactly the renewable denial of service the
 * comment above forbids and exactly the harm authn-authz-03 closed on the admin
 * side (five wrong passwords from a stranger 403'd the real admin's live
 * cookie). So the column never stands alone: whenever we arm it we also write
 * this key, holding the IP whose failure crossed the threshold, with the same
 * TTL as the lock itself.
 *
 * That turns "is Redis still able to tell attacker from victim?" into something
 * we can actually ask at sign-in:
 *
 *   marker PRESENT  → Redis remembers the attack. Enforce the durable lock only
 *                     against the IP it names; everyone else falls through to
 *                     their own per-(account+IP) bucket, which is A1-01 intact.
 *   marker ABSENT   → Redis was flushed, restarted or is unreachable, so the
 *                     per-IP evidence is gone and there is nothing left to scope
 *                     by. Enforce account-wide. This is the audited hole: six
 *                     wrong logins, `redis-cli del` the two keys, correct
 *                     password, 200. It now 401s.
 *
 * An operator's hand-written `UPDATE users SET "lockedUntil" = …` writes no
 * marker either, so a deliberate freeze is account-wide, which is what an
 * operator freezing an account means.
 */
const LOCK_SCOPE_KEY = (uid: string): string => `login:lock-scope:${uid}`;

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
    //
    // `users.lockedUntil` was selected here and never read, and the only writes
    // in the whole tenant path set it to NULL — so the "per-account lockout is
    // the backstop" that rate-limit.service.ts leans on when IT fails open did
    // not exist. A probe deleted the two Redis keys after five wrong passwords
    // and signed straight in with the correct password: 200.
    //
    // The first attempt at this read the column but only ever WROTE it when
    // Redis threw, so the audited bypass — healthy Redis, five wrong passwords,
    // `redis-cli del`, correct password — still returned 200 because
    // `lockedUntil` was still NULL. recordFailure() arms it on the normal path
    // now. Three things write it: that threshold, and an operator freezing an
    // account by hand (`UPDATE users SET "lockedUntil" = now() + interval '1
    // hour'`), and a successful sign-in clearing it.
    //
    // Whether the lock applies to THIS caller is not "is it in the future" —
    // see LOCK_SCOPE_KEY for why a bare-account lock would be a remotely
    // triggerable outage of every librarian's account.
    if (
      user.lockedUntil &&
      user.lockedUntil.getTime() > Date.now() &&
      (await this.durableLockApplies(user.id, ip))
    ) {
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
    // The scope marker goes with the lock it scoped. Leaving it behind would
    // survive into the NEXT lockout and point at a stale IP, which is the one
    // way this key could weaken the account-wide fallback rather than narrow it.
    await this.redis.client
      .del(FAIL_KEY(user.id, ip), LOCK_KEY(user.id, ip), LOCK_SCOPE_KEY(user.id))
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

  /** True when (account, ip) is currently locked. Fails OPEN if Redis is down —
   *  which is safe only because `users.lockedUntil` now covers that case; see
   *  {@link durableLockApplies}. */
  private async isLockedOut(userId: string, ip: string): Promise<boolean> {
    try {
      return (await this.redis.client.get(LOCK_KEY(userId, ip))) !== null;
    } catch {
      return false;
    }
  }

  /**
   * Does the live `users.lockedUntil` bar THIS caller? See {@link LOCK_SCOPE_KEY}.
   *
   * Fails CLOSED on every uncertainty — a missing marker, an unreadable one, a
   * Redis that will not answer — because the uncertainty IS the audited attack
   * state. The whole finding is that when Redis loses its memory the account
   * becomes freely guessable; answering "no idea, let them try" here would
   * rebuild that hole one layer up.
   */
  private async durableLockApplies(userId: string, ip: string): Promise<boolean> {
    let scope: string | null;
    try {
      scope = await this.redis.client.get(LOCK_SCOPE_KEY(userId));
    } catch {
      scope = null;
    }
    if (scope === null) return true;
    return scope === ip;
  }

  private async recordFailure(userId: string, ip: string): Promise<void> {
    const windowSec = Math.ceil(this.env.loginLockoutMs / 1000);
    const lockedUntil = new Date(Date.now() + windowSec * 1000);

    // ONE statement: the tally and the lock it triggers are decided by the same
    // row version, so two simultaneous failures cannot both read 4 and neither
    // arm the lock. Prisma's fluent API cannot express "set this column only if
    // the value you just computed crossed a threshold", and doing it as a
    // read-then-write is exactly the race a lockout must not have.
    //
    // `failedLogins` only ever resets on a SUCCESSFUL sign-in, so once an
    // account is over the threshold every further wrong password re-arms a
    // fresh window. That is what makes this survive the second half of the
    // audited bypass ("just let the 15-minute keys expire"): the lock lapses,
    // the next guess re-arms it, and a sustained attacker is held to one
    // attempt per LOGIN_LOCKOUT_MS with Redis out of the picture entirely.
    type FailureRow = { failedLogins: number; lockedUntil: Date | null };
    let row: FailureRow | undefined;
    try {
      const rows = await controlDb.$queryRaw<FailureRow[]>`
        UPDATE users
           SET "failedLogins" = "failedLogins" + 1,
               "lockedUntil" = CASE
                 WHEN "failedLogins" + 1 >= ${this.env.maxFailedLogins}
                   THEN ${lockedUntil}
                 ELSE "lockedUntil"
               END
         WHERE id = ${userId}
        RETURNING "failedLogins", "lockedUntil"`;
      row = rows[0];
    } catch (err) {
      // Not swallowed: this write IS the durable lockout now, not a tally kept
      // for colour. Losing it silently is losing the backstop silently.
      this.logger.error(
        `Could not record a failed sign-in for user ${userId} — the durable lockout was NOT ` +
          `written and this account is protected only by Redis: ${(err as Error).message}`,
      );
    }

    const armed = !!row && row.failedLogins >= this.env.maxFailedLogins;
    if (armed) {
      this.logger.warn(
        `Login locked in the DATABASE for user ${userId} until ${lockedUntil.toISOString()} after ` +
          `${row?.failedLogins} failed sign-ins.`,
      );
    }

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
      // Scope the durable lock to the client that armed it, so a victim signing
      // in from their own address is unaffected (A1-01 / authn-authz-03). Keyed
      // on the DURABLE threshold, not the per-IP one: an attacker spread over
      // five addresses reaches `failedLogins = 5` with each per-IP counter still
      // at 1, and without this the account-wide lock would fire for everyone
      // after five distributed guesses — a cheaper DoS than the one A1-01 removed.
      if (armed) await this.writeLockScope(userId, ip, windowSec);
    } catch (err) {
      // Redis is unreachable. `isLockedOut` fails open and RateLimitService.hit
      // fails open for the login bucket, so the row we just wrote is the ONLY
      // brute-force protection left — and with no marker to scope it, it is
      // enforced account-wide, which is the correct reading of "we can no
      // longer tell the attacker from the victim".
      this.logger.error(
        `Redis is unavailable (${(err as Error).message}); the per-IP login lockout is off. ` +
          `User ${userId} is ${armed ? 'locked account-wide in the DATABASE' : 'still under the threshold'} ` +
          `(${row?.failedLogins ?? 'unknown'} failures). This is the degraded mode, not the normal one.`,
      );
    }
  }

  /**
   * Record which client armed the durable lock. A missing marker means
   * "enforce account-wide", so failing to write one only ever makes the lock
   * stricter — never weaker — which is why this cannot fail the sign-in.
   */
  private async writeLockScope(userId: string, ip: string, windowSec: number): Promise<void> {
    if (isIP(ip) === 0) {
      // No verified address (`clientIp()` returned nothing, or a non-HTTP
      // caller). There is nothing to scope by, so the durable lock stays
      // account-wide — but say so, because in that state a stranger's five
      // guesses do lock the real user out, which is the authn-authz-03 shape.
      // In production `clientIp()` always yields the TCP peer, so reaching this
      // line means a call site is not passing it.
      this.logger.error(
        `Failed sign-in for user ${userId} carried no usable client IP (${JSON.stringify(ip).slice(0, 64)}) — ` +
          'the durable lockout will be enforced ACCOUNT-WIDE. The caller must pass clientIp(req).',
      );
      return;
    }
    await this.redis.client.set(LOCK_SCOPE_KEY(userId), ip, 'EX', windowSec);
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException("We couldn't sign you in with those details.");
  }
}
