import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { PasswordService } from './password.service.js';
import { JwtSessionService } from './jwt-session.service.js';
import type { SessionPayload } from './jwt-session.service.js';

export type LoginResult = {
  token: string;
  expiresAt: Date;
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
  }): Promise<LoginResult> {
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
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.passwords.dummyVerify(input.password);
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedException(
        `Too many failed attempts. Please try again in ${minutes} minute(s).`,
      );
    }

    const ok = await this.passwords.verify(input.password, user.passwordHash);
    if (!ok) {
      await this.recordFailure(user.id, user.failedLogins);
      throw this.invalidCredentials();
    }

    // Success — reset counters, stamp lastLoginAt, issue session.
    await controlDb.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const { token, expiresAt } = this.jwt.sign({
      sub: user.id,
      tid: tenant.id,
      role: user.role as SessionPayload['role'],
    });
    return {
      token,
      expiresAt,
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
    const data: { fullName?: string; passwordHash?: string; mustChangeCredentials: boolean } = {
      mustChangeCredentials: false,
    };
    if (input.fullName && input.fullName.trim()) data.fullName = input.fullName.trim();
    if (input.newPassword) data.passwordHash = await this.passwords.hash(input.newPassword);
    await controlDb.user.update({ where: { id: userId }, data });
  }

  private async recordFailure(userId: string, currentFailed: number): Promise<void> {
    const nextCount = currentFailed + 1;
    const shouldLock = nextCount >= this.env.maxFailedLogins;
    await controlDb.user.update({
      where: { id: userId },
      data: {
        failedLogins: nextCount,
        lockedUntil: shouldLock ? new Date(Date.now() + this.env.loginLockoutMs) : undefined,
      },
    });
    if (shouldLock) {
      this.logger.warn(
        `User ${userId} locked after ${nextCount} failed attempts (until ${new Date(
          Date.now() + this.env.loginLockoutMs,
        ).toISOString()}).`,
      );
    }
  }

  private invalidCredentials(): UnauthorizedException {
    return new UnauthorizedException("We couldn't sign you in with those details.");
  }
}
