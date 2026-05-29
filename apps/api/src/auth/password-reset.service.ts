import { Inject, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { RedisService } from '../platform/redis.service.js';
import { PasswordService } from './password.service.js';

/**
 * Password-reset flow.
 *
 * - `request()` always returns the same generic OK to avoid leaking which
 *   emails are registered. If the (tenant, email) combo exists, a one-time
 *   reset token is generated, stored in Redis with a 60-minute TTL, and
 *   the reset link is enqueued for delivery via Step 18d's email pipeline.
 * - `complete()` consumes a token and sets a new password atomically.
 *
 * Idempotency: a (tenant, user, minute-bucket) key prevents the same
 * one-minute window from queuing multiple identical reset emails if the
 * user spam-clicks "Forgot password".
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private static readonly TOKEN_TTL_SEC = 60 * 60;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(EmailService) private readonly emails: EmailService,
  ) {}

  /**
   * Always returns void. Whether or not the email exists, the caller's
   * response is identical to prevent enumeration.
   */
  async request(input: { tenantSlug: string; email: string }): Promise<void> {
    const tenant = await controlDb.tenant.findUnique({
      where: { slug: input.tenantSlug },
      select: { id: true, slug: true, name: true, status: true, defaultLocale: true },
    });
    if (!tenant || tenant.status !== 'active') return;

    const user = await controlDb.user.findUnique({
      where: { tenantId_email: { tenantId: tenant.id, email: input.email } },
      select: { id: true, status: true, fullName: true },
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
    const env = loadEnv();
    const resetLink = `${env.publicAppUrl}/${tenant.defaultLocale}/login/reset?token=${token}&slug=${tenant.slug}`;
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const body = [
      `Hi ${user.fullName},`,
      ``,
      `Someone (hopefully you) asked to reset your password for ${tenant.name}.`,
      `Open this link to set a new one — it expires in 60 minutes:`,
      ``,
      `  ${resetLink}`,
      ``,
      `If this wasn't you, ignore this email. Nothing changes until the link`,
      `is opened and a new password is set.`,
      ``,
      `— Libriant`,
    ].join('\n');
    try {
      await this.emails.enqueue({
        kind: 'password_reset',
        toEmail: input.email,
        tenantId: tenant.id,
        idempotencyKey: `auth.password_reset:${user.id}:${minuteBucket}`,
        subject: `Reset your ${tenant.name} password`,
        bodyMarkdown: body,
        // Resets are intentionally low-retry: a transient SMTP hiccup
        // can stall this for half an hour without harm (the user will
        // click "forgot" again), and the token TTL is the real timer.
        maxAttempts: 2,
        metadata: { userId: user.id },
      });
    } catch (err) {
      this.logger.warn(
        `password-reset enqueue failed for user=${input.email}: ${(err as Error).message}`,
      );
    }
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
