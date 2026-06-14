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
    const env = loadEnv();
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
      const nextAttempts = admin.failedAttempts + 1;
      const locked = nextAttempts >= env.maxFailedLogins;
      await controlDb.adminUser.update({
        where: { id: admin.id },
        data: {
          failedAttempts: nextAttempts,
          lockedUntil: locked ? new Date(Date.now() + env.loginLockoutMs) : null,
          status: locked ? 'locked' : admin.status,
        },
      });
      throw new UnauthorizedException('Email or password is wrong.');
    }

    // Reset status to 'active' too — a prior lockout set status:'locked', and
    // without restoring it here the AdminAuthGuard would 403 every request
    // forever even after a successful sign-in (the lockout was permanent). A
    // 'disabled' account never reaches this point (it throws above), so it's
    // safe to force 'active' on success.
    await controlDb.adminUser.update({
      where: { id: admin.id },
      data: { failedAttempts: 0, lockedUntil: null, status: 'active', lastLoginAt: new Date() },
    });

    return {
      id: admin.id,
      role: admin.role,
      fullName: admin.fullName,
      email: admin.email,
    };
  }
}
