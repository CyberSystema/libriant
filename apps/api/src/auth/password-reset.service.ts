import { Inject, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import { RedisService } from '../platform/redis.service.js';
import { PasswordService } from './password.service.js';

/**
 * Password-reset stub.
 *
 * - `request()` always returns the same generic OK to avoid leaking which
 *   emails are registered. If the (tenant, email) combo exists, a one-time
 *   reset token is generated, stored in Redis with a 60-minute TTL, and
 *   logged so a human (or future EmailService) can deliver it.
 * - `complete()` consumes a token and sets a new password atomically.
 *
 * When the email service lands, the only change here is replacing the
 * `console.log` with a `Mailer.send(...)` call.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private static readonly TOKEN_TTL_SEC = 60 * 60;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  /**
   * Always returns void. Whether or not the email exists, the caller's
   * response is identical to prevent enumeration.
   */
  async request(input: { tenantSlug: string; email: string }): Promise<void> {
    const tenant = await controlDb.tenant.findUnique({
      where: { slug: input.tenantSlug },
      select: { id: true, name: true, status: true },
    });
    if (!tenant || tenant.status !== 'active') return;

    const user = await controlDb.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
      select: { id: true, status: true },
    });
    if (!user || user.status !== 'active') return;

    const token = crypto.randomBytes(32).toString('base64url');
    const key = `pwreset:${token}`;
    await this.redis.client.set(
      key,
      JSON.stringify({ uid: user.id, tid: tenant.id }),
      'EX',
      PasswordResetService.TOKEN_TTL_SEC,
    );
    // TODO(email): replace with Mailer.send. For now we log the link so a
    // dev / support can hand it to the user.
    this.logger.warn(
      `[PASSWORD RESET] tenant=${tenant.name} user=${input.email} token=${token} ` +
        `(valid 60min). Deliver via: <reset-link>?token=${token}`,
    );
  }

  /**
   * Returns true if the token was consumed and the password updated; false
   * otherwise. Tokens are one-time-use (DEL on success).
   */
  async complete(input: { token: string; newPassword: string }): Promise<boolean> {
    const key = `pwreset:${input.token}`;
    const raw = await this.redis.client.get(key);
    if (!raw) return false;
    let parsed: { uid: string; tid: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.redis.client.del(key);
      return false;
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    const updated = await controlDb.user.updateMany({
      where: { id: parsed.uid, tenantId: parsed.tid, status: 'active' },
      data: { passwordHash, failedLogins: 0, lockedUntil: null },
    });
    await this.redis.client.del(key);
    return updated.count === 1;
  }
}
