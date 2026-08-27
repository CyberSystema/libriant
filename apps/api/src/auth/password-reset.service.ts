import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { controlDb } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { RedisService } from '../platform/redis.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { AuthGuard } from './auth.guard.js';
import { PasswordService } from './password.service.js';
import { PASSWORD_RESET_TOKEN_TTL_SEC } from './one-time-link-ttl.js';
import { tokenKey } from './token-digest.js';

/**
 * Password-reset flow.
 *
 * - `request()` always returns the same generic OK to avoid leaking which
 *   emails are registered. If the (tenant, email) combo exists, a one-time
 *   reset token is generated, its SHA-256 digest is stored in Redis with a
 *   60-minute TTL (authn-authz-11 — see token-digest.ts), and the reset link is
 *   enqueued for delivery via Step 18d's email pipeline.
 * - `complete()` consumes a token and sets a new password atomically.
 *
 * Idempotency: a (tenant, user, minute-bucket) key prevents the same
 * one-minute window from queuing multiple identical reset emails if the
 * user spam-clicks "Forgot password".
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);
  private static readonly TOKEN_TTL_SEC = PASSWORD_RESET_TOKEN_TTL_SEC;

  /** Per-target cap: at most this many reset emails per rolling window. */
  private static readonly PER_TARGET_LIMIT = 3;
  private static readonly PER_TARGET_WINDOW_SEC = 15 * 60;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(EmailService) private readonly emails: EmailService,
  ) {}

  /**
   * Always returns void. Whether or not the email exists, the caller's
   * response is identical to prevent enumeration.
   */
  async request(input: { tenantSlug: string; email: string }): Promise<void> {
    // FAILS CLOSED, and does so BEFORE the account lookup.
    //
    // Redis is not a cache here — it is where the single-use token lives. If
    // the write fails, the link in the message points at a token that does not
    // exist, so the reader follows it and is told their link is invalid. A
    // silent success is the worst outcome available.
    //
    // The check is up here rather than around the write for a reason: this
    // endpoint deliberately reveals nothing about whether an account exists, and
    // a 503 that only ever appeared for real accounts would be exactly that
    // oracle. Checking before the lookup means everyone gets the same answer.
    if (!(await this.redis.ping())) {
      throw new ServiceUnavailableException(
        'We cannot issue that link right now. Nothing was sent — please try again in a moment.',
      );
    }

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

    // Per-target throttle: bound how many reset emails a single account can be
    // sent over a rolling window, independent of the per-minute idempotency
    // bucket below. Over budget → return silently (preserves no-enumeration).
    const within = await this.rateLimit.hit(
      `pwreset:acct:${tenant.id}:${user.id}`,
      PasswordResetService.PER_TARGET_LIMIT,
      PasswordResetService.PER_TARGET_WINDOW_SEC,
    );
    if (!within.allowed) {
      this.logger.warn(`password-reset throttled for user=${user.id} tenant=${tenant.id}`);
      return;
    }

    const token = crypto.randomBytes(32).toString('base64url');
    // The token itself never reaches Redis — only its digest does. See
    // token-digest.ts (authn-authz-11).
    await this.redis.client.set(
      tokenKey('pwreset', token),
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
    // Claim the token ATOMICALLY before doing any work (AUTH-08): GETDEL returns
    // the value and deletes it in one round-trip, so a token can't be replayed
    // or raced — only the caller that wins the delete proceeds. It is the
    // DIGEST of the submitted token that names the key (authn-authz-11); a
    // wrong token simply digests to a key that does not exist.
    const raw = await this.redis.client.getdel(tokenKey('pwreset', input.token));
    if (!raw) return false;
    let parsed: { uid: string; tid: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    const updated = await controlDb.user.updateMany({
      where: { id: parsed.uid, tenantId: parsed.tid, status: 'active' },
      // Bump sessionsValidAfter so any session the attacker already holds is
      // invalidated by the reset (AUTH-01) — the whole point of recovery.
      data: {
        passwordHash,
        failedLogins: 0,
        lockedUntil: null,
        sessionsValidAfter: new Date(),
      },
    });
    if (updated.count === 1) {
      await AuthGuard.invalidateAuthCache(this.redis, parsed.uid);
    }
    return updated.count === 1;
  }
}
