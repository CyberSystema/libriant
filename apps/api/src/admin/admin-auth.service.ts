import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { PasswordService } from '../auth/password.service.js';

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

@Injectable()
export class AdminAuthService {
  constructor(@Inject(PasswordService) private readonly passwords: PasswordService) {}

  /**
   * Verify an admin's credentials. Failed attempts increment a counter and
   * lock the account for `loginLockoutMs` once the threshold is reached.
   * Success resets the counter and stamps `lastLoginAt`.
   */
  async verify(
    email: string,
    password: string,
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
        passwordHash: true,
        failedAttempts: true,
        lockedUntil: true,
      },
    });
    if (!admin) {
      // Burn ~250ms on a fake hash to keep timing equal to the
      // username-known path. Same trick the tenant auth uses.
      await this.passwords.dummyVerify(password);
      throw new UnauthorizedException('Email or password is wrong.');
    }
    if (admin.disabledAt || admin.status === 'disabled') {
      throw new UnauthorizedException('This admin account is disabled.');
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw new UnauthorizedException(
        'Too many failed sign-in attempts. Try again in a few minutes.',
      );
    }

    const ok = await this.passwords.verify(password, admin.passwordHash);
    if (!ok) {
      await this.recordFailure(admin.id);
      throw new UnauthorizedException('Email or password is wrong.');
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
   * Count a failed attempt (wrong password OR wrong TOTP) atomically and lock
   * the account once the threshold is reached. Atomic increment (AUTH-03) so a
   * burst of concurrent guesses can't register as one and slip the lockout.
   */
  async recordFailure(adminId: string): Promise<void> {
    const env = loadEnv();
    const updated = await controlDb.adminUser.update({
      where: { id: adminId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    if (updated.failedAttempts >= env.maxFailedLogins) {
      await controlDb.adminUser.update({
        where: { id: adminId },
        data: { lockedUntil: new Date(Date.now() + env.loginLockoutMs), status: 'locked' },
      });
    }
  }

  /**
   * Clear counters + lockout and stamp lastLoginAt after a FULLY successful
   * login (password AND, when enabled, TOTP). Restoring status:'active' lifts a
   * prior lockout so the guard stops 403ing once the admin signs in cleanly.
   */
  async recordSuccess(adminId: string): Promise<void> {
    await controlDb.adminUser.update({
      where: { id: adminId },
      data: { failedAttempts: 0, lockedUntil: null, status: 'active', lastLoginAt: new Date() },
    });
  }
}
