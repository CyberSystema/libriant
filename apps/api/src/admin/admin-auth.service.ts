import { isIP } from 'node:net';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { PasswordService } from '../auth/password.service.js';
import { RedisService } from '../platform/redis.service.js';

/** Admin login result — minimal because the cookie carries the session. */
export type AdminLoginResult = {
  id: string;
  email: string;
  fullName: string;
  role: 'owner' | 'support';
  /** Token + expiry passed to the cookie service. */
  token: string;
  expiresAt: Date;
};

// authn-authz-03: the admin lockout is scoped to (account + source IP) in
// Redis, exactly like the tenant one (login.service.ts, A1-01). It used to be a
// bare-account lock written into the DB — `lockedUntil` AND `status = 'locked'`
// — and AdminAuthGuard reads `status` as "account disabled", so five wrong
// passwords from an unauthenticated stranger who knew an admin's email address
// 403'd that admin's LIVE session cookie and kept 403ing it, renewably, with no
// in-app unlock. Three rules follow from that and must not be undone:
//   1. the lock lives in Redis, keyed on the IP, so it can only ever affect the
//      attacker's own bucket;
//   2. nothing on the unauthenticated path writes `adminUser.status`;
//   3. a bucket must be a VERIFIED IP ADDRESS — see {@link lockBucket}.
const FAIL_KEY = (adminId: string, ip: string): string => `admin-login:fail:${adminId}:${ip}`;
const LOCK_KEY = (adminId: string, ip: string): string => `admin-login:lock:${adminId}:${ip}`;

/**
 * Rule 3. A lockout key may only be built from an address a TCP handshake
 * proved — never from a placeholder.
 *
 * The first fix moved the lock out of the DB and keyed it on `ip`, with `ip`
 * defaulting to the string `'unknown'`. Every caller that does not supply one
 * therefore shares a single bucket per admin, and a verifier used it: five bad
 * passwords wrote `admin-login:lock:<adminId>:unknown`, and because the real
 * admin's attempt reads the SAME key, they were locked out for 15 minutes by an
 * unauthenticated stranger. A weaker version of the exact DoS the finding was
 * about, surviving in the placeholder.
 *
 * So an unidentified caller now gets no lock at all: nothing is written, and
 * nothing is read. That is a deliberate trade — brute force from a caller we
 * cannot identify is bounded only by the per-IP limiter in
 * admin-auth.controller (20 / 5 min), which is weaker than a 5-attempt lock.
 * We take it because a lock that an anonymous party can point at a named admin
 * is a remote-controlled outage of the control plane, and the control plane is
 * how you respond to an incident. The right end state is that every caller
 * passes a real IP; when one does not, {@link AdminAuthService.recordFailure}
 * logs at error rather than degrading quietly.
 */
function lockBucket(ip: string): string | undefined {
  return isIP(ip) === 0 ? undefined : ip;
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly env = loadEnv();

  constructor(
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  /**
   * Verify an admin's credentials. Failed attempts from the SAME source IP
   * accumulate and lock that (admin, IP) pair for `loginLockoutMs`; a full
   * success clears the counters and stamps `lastLoginAt`.
   *
   * `ip` comes from `clientIp(req)` and is what scopes the lockout. PASS IT.
   * It is optional only so this stays callable from a context without a
   * request, and an omitted (or unparseable) IP now means NO lockout at all
   * rather than a shared one — see {@link lockBucket} for why that is the safer
   * of the two failure modes and what it costs.
   */
  async verify(
    email: string,
    password: string,
    ip = 'unknown',
  ): Promise<{ id: string; role: 'owner' | 'support'; fullName: string; email: string }> {
    const admin = await controlDb.adminUser.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        status: true,
        disabledAt: true,
        // Read, not written. Nothing on this unauthenticated path may write
        // `lockedUntil` (rule 2 above) — but a row can carry one from before
        // that rule existed, or because an operator set it by hand with psql to
        // freeze an account during an incident, which is the recovery story
        // authn-authz-03 assumes exists. The first fix dropped the column from
        // this select entirely, which silently turned both of those into no-ops:
        // a deliberate operator lock looked applied and did nothing.
        lockedUntil: true,
        passwordHash: true,
      },
    });
    if (!admin) {
      // Burn ~250ms on a fake hash to keep timing equal to the
      // username-known path. Same trick the tenant auth uses.
      await this.passwords.dummyVerify(password);
      throw this.wrongCredentials();
    }
    if (admin.disabledAt || admin.status === 'disabled') {
      throw new UnauthorizedException('This admin account is disabled.');
    }
    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      // Same generic failure as everything else (AUTH-02): a distinct message
      // would confirm the address belongs to a real admin. Clearing it is
      // `UPDATE admin_users SET "lockedUntil" = NULL WHERE email = '…';` — or a
      // successful sign-in once it expires, which recordSuccess() heals.
      await this.passwords.dummyVerify(password);
      throw this.wrongCredentials();
    }
    if (await this.isLockedOut(admin.id, ip)) {
      // AUTH-02: do NOT say "locked". A distinct lockout message confirms the
      // address belongs to a real admin. Same generic failure as every other
      // path, dummy verify included so the timing matches too.
      await this.passwords.dummyVerify(password);
      throw this.wrongCredentials();
    }

    const ok = await this.passwords.verify(password, admin.passwordHash);
    if (!ok) {
      await this.recordFailure(admin.id, ip);
      throw this.wrongCredentials();
    }

    // Password is correct, but DON'T reset counters / stamp lastLoginAt yet
    // (ADM-5): when MFA is enabled the login is incomplete until the TOTP
    // check passes. The controller calls recordSuccess() only after the FULL
    // login succeeds, and recordFailure() on a wrong TOTP — so a known password
    // with a brute-forced second factor still trips the lockout.
    return {
      id: admin.id,
      role: admin.role,
      fullName: admin.fullName,
      email: admin.email,
    };
  }

  /**
   * Count a failed attempt (wrong password OR wrong TOTP) and lock the
   * (admin, IP) pair once the threshold is reached.
   *
   * The DB `failedAttempts` tally is kept for audit/visibility only (atomic
   * increment, AUTH-03) — the LOCK decision is the Redis key. Nothing here
   * writes `status` or `lockedUntil`: those are the columns the guard reads as
   * "this account is disabled", and unauthenticated input must never reach them.
   */
  async recordFailure(adminId: string, ip = 'unknown'): Promise<void> {
    const bucket = lockBucket(ip);

    // The audit event, emitted FIRST and independently of the database. The DB
    // write below was `.catch(() => undefined)` — a swallowed audit write, so a
    // broken column, a connection blip or a permissions change would silently
    // stop the only record that a failed admin sign-in ever happened, and
    // nothing anywhere would say so. An audit trail that can disappear quietly
    // is not an audit trail; this line cannot fail closed on the DB.
    this.logger.warn(
      `Failed admin sign-in for ${adminId} from ${bucket ?? 'an unidentified client'}.`,
    );
    try {
      await controlDb.adminUser.update({
        where: { id: adminId },
        data: { failedAttempts: { increment: 1 } },
        select: { failedAttempts: true },
      });
    } catch (err) {
      // Logged at ERROR, not swallowed: the tally is what the admin UI and any
      // later investigation read, so it drifting is a fact someone must see.
      // Still not rethrown — a failed audit write must not turn a wrong password
      // into a 500, and above all must not skip the Redis lockout below, which
      // is the control that actually stops the attack.
      this.logger.error(
        `Could not increment failedAttempts for admin ${adminId} — the DB audit tally is now ` +
          `behind the real number of failed sign-ins: ${(err as Error).message}`,
      );
    }

    if (!bucket) {
      // Rule 3: no verified IP, no lock. Loud, because the only way to get here
      // is a caller that did not pass clientIp(req) — the lockout is silently
      // not being applied for that endpoint until someone fixes the call site.
      this.logger.error(
        `Admin sign-in failure for ${adminId} carried no usable client IP (${JSON.stringify(ip).slice(0, 64)}) — ` +
          'the per-IP lockout is NOT being applied. The caller must pass clientIp(req).',
      );
      return;
    }

    try {
      const windowSec = Math.ceil(this.env.loginLockoutMs / 1000);
      const failKey = FAIL_KEY(adminId, bucket);
      const n = await this.redis.client.incr(failKey);
      if (n === 1) await this.redis.client.expire(failKey, windowSec);
      if (n >= this.env.maxFailedLogins) {
        await this.redis.client.set(LOCK_KEY(adminId, bucket), '1', 'EX', windowSec);
        this.logger.warn(
          `Admin sign-in locked for ${adminId} from ${bucket} after ${n} failed attempts (${windowSec}s).`,
        );
      }
    } catch {
      // Redis down → no lockout this attempt (fail open, parity with the tenant
      // login); the per-IP limiter in admin-auth.controller still bounds the rate.
    }
  }

  /**
   * Clear counters + lockout and stamp lastLoginAt after a FULLY successful
   * login (password AND, when enabled, TOTP).
   *
   * `status: 'active'` and `lockedUntil: null` are written here purely to heal
   * rows the OLD bare-account lockout left behind (authn-authz-03) — an admin
   * stuck at `status = 'locked'` is 403'd by AdminAuthGuard until something
   * clears it, and a clean sign-in is the safe moment. Nothing writes those
   * columns any more, so for every row created after that fix this is a no-op.
   */
  async recordSuccess(adminId: string, ip = 'unknown'): Promise<void> {
    await controlDb.adminUser.update({
      where: { id: adminId },
      data: { failedAttempts: 0, lockedUntil: null, status: 'active', lastLoginAt: new Date() },
    });
    await this.redis.client
      .del(FAIL_KEY(adminId, ip), LOCK_KEY(adminId, ip))
      .catch(() => undefined);
  }

  /** True when (admin, ip) is currently locked. Fails OPEN if Redis is down so
   *  an outage never blocks every admin sign-in (parity with the tenant login). */
  private async isLockedOut(adminId: string, ip: string): Promise<boolean> {
    const bucket = lockBucket(ip);
    // No verified IP → there is no bucket to be locked in. Reading the shared
    // placeholder key here is what let a stranger's five failures block the
    // real admin; see {@link lockBucket}.
    if (!bucket) return false;
    try {
      return (await this.redis.client.get(LOCK_KEY(adminId, bucket))) !== null;
    } catch {
      return false;
    }
  }

  private wrongCredentials(): UnauthorizedException {
    return new UnauthorizedException('Email or password is wrong.');
  }
}
