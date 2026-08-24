import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { controlDb, Prisma } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { RedisService } from '../platform/redis.service.js';

/** What we stash in Redis under the one-time verification token. */
type VerifyPayload = {
  uid: string;
  tid: string;
  /** The address being confirmed. For `signup` it's the current email; for
   *  `change` it's the NEW address that becomes the email once confirmed. */
  email: string;
  mode: 'signup' | 'change';
};

export type VerifyResult =
  { ok: true; mode: 'signup' | 'change'; slug: string | null } | { ok: false };

/**
 * Account email verification.
 *
 *   send()                — issue a one-time token + enqueue the verify email.
 *   verify()              — consume a token, mark the address verified (or apply
 *                           a staged email change), and welcome a first-time owner.
 *   resend()              — re-send to the signed-in user's current address.
 *   requestEmailChange()  — stage a NEW address + send a verify link to it; the
 *                           account email only changes once that link is clicked.
 *
 * Soft gate: an unverified user can still sign in; `EmailVerifiedGuard` blocks
 * the verification-sensitive actions until `users.emailVerifiedAt` is set.
 *
 * Mirrors PasswordResetService: Redis-stored token (atomic GETDEL claim on
 * verify), per-account rate limit, idempotency-keyed enqueue.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);
  private static readonly TOKEN_TTL_SEC = 24 * 60 * 60;
  /** Per-account resend cap over a rolling window. */
  private static readonly PER_TARGET_LIMIT = 5;
  private static readonly PER_TARGET_WINDOW_SEC = 60 * 60;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(EmailService) private readonly emails: EmailService,
  ) {}

  /**
   * Issue a token and enqueue the verification email. Caller supplies the
   * tenant context it already has (signup) — `resend`/`requestEmailChange`
   * look it up. Throttled per account; over budget logs + returns quietly.
   */
  async send(input: {
    userId: string;
    tenantId: string;
    email: string;
    slug: string;
    locale: string;
    libraryName: string;
    mode: 'signup' | 'change';
  }): Promise<void> {
    // FAILS CLOSED, and does so BEFORE the account lookup.
    //
    // Redis is not a cache here — it is where the single-use token lives. If
    // the write fails, the link in the message points at a token that does not
    // exist, so the reader follows it and is told their link is invalid. A
    // silent success is the worst outcome available.
    //
    // The check is up here rather than around the write for a reason: the
    // caller must not learn anything from WHICH request failed, and a 503 that
    // only ever appeared for real accounts would be exactly that oracle.
    if (!(await this.redis.ping())) {
      throw new ServiceUnavailableException(
        'We cannot issue that link right now. Nothing was sent — please try again in a moment.',
      );
    }

    const within = await this.rateLimit.hit(
      `emailverify:acct:${input.tenantId}:${input.userId}`,
      EmailVerificationService.PER_TARGET_LIMIT,
      EmailVerificationService.PER_TARGET_WINDOW_SEC,
    );
    if (!within.allowed) {
      this.logger.warn(`email-verification throttled for user=${input.userId}`);
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const payload: VerifyPayload = {
      uid: input.userId,
      tid: input.tenantId,
      email: input.email,
      mode: input.mode,
    };
    await this.redis.client.set(
      `emailverify:${token}`,
      JSON.stringify(payload),
      'EX',
      EmailVerificationService.TOKEN_TTL_SEC,
    );

    const env = loadEnv();
    const link = `${env.publicAppUrl}/${input.locale}/verify-email?token=${token}`;
    const intro =
      input.mode === 'change'
        ? `Confirm this is your new email address for ${input.libraryName}.`
        : `Welcome to ${input.libraryName}! Confirm your email address to finish setting up.`;
    const body = [
      `Hi,`,
      ``,
      intro,
      `Open this link to verify — it expires in 24 hours:`,
      ``,
      `  ${link}`,
      ``,
      `If you didn't request this, you can ignore this email.`,
      ``,
      `— Libriant`,
    ].join('\n');

    const minuteBucket = Math.floor(Date.now() / 60_000);
    try {
      await this.emails.enqueue({
        kind: 'email_verification',
        toEmail: input.email,
        tenantId: input.tenantId,
        idempotencyKey: `auth.email_verification:${input.userId}:${input.mode}:${minuteBucket}`,
        subject:
          input.mode === 'change'
            ? `Confirm your new ${input.libraryName} email`
            : `Verify your ${input.libraryName} email`,
        bodyMarkdown: body,
        maxAttempts: 3,
        metadata: { userId: input.userId, mode: input.mode },
      });
    } catch (err) {
      this.logger.warn(
        `email-verification enqueue failed for user=${input.userId}: ${(err as Error).message}`,
      );
    }
  }

  /** Consume a token and apply it. Returns `{ ok:false }` for any bad/expired token. */
  async verify(token: string): Promise<VerifyResult> {
    // Atomic single-use claim (GETDEL) — a token can't be replayed or raced.
    const raw = await this.redis.client.getdel(`emailverify:${token}`);
    if (!raw) return { ok: false };
    let p: VerifyPayload;
    try {
      p = JSON.parse(raw) as VerifyPayload;
    } catch {
      return { ok: false };
    }

    const slug = await this.slugFor(p.tid);
    if (p.mode === 'change') {
      try {
        // Apply the staged address. Guard on id + tenant; uniqueness is enforced
        // by the @@unique([tenantId, email]) index (handled below).
        const upd = await controlDb.user.updateMany({
          where: { id: p.uid, tenantId: p.tid },
          data: { email: p.email, emailVerifiedAt: new Date() },
        });
        return upd.count === 1 ? { ok: true, mode: 'change', slug } : { ok: false };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BadRequestException('That email is already used by another account here.');
        }
        throw err;
      }
    }

    // signup: only the first null→set transition counts (and only if the email
    // still matches the token — a since-changed address shouldn't be verified
    // by an old link). A re-click is a harmless no-op (count 0).
    const upd = await controlDb.user.updateMany({
      where: { id: p.uid, email: p.email, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    if (upd.count === 1) await this.sendWelcome(p.uid, p.tid, p.email);
    // count 0 = already verified or email changed — still report success so a
    // double-click doesn't look like a failure to the user.
    return { ok: true, mode: 'signup', slug };
  }

  /** Re-send a verification email to the signed-in user's current address. */
  async resend(userId: string): Promise<void> {
    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true, status: true, tenantId: true },
    });
    // No email (staff) / already verified / inactive → nothing to do. Quiet
    // success keeps this from being an account-state oracle.
    if (!user?.email || user.emailVerifiedAt || user.status !== 'active') return;
    const tenant = await this.tenantCtx(user.tenantId);
    if (!tenant) return;
    await this.send({
      userId,
      tenantId: user.tenantId,
      email: user.email,
      slug: tenant.slug,
      locale: tenant.defaultLocale,
      libraryName: tenant.name,
      mode: 'signup',
    });
  }

  /** Stage an email change: validate, then send a verify link to the NEW address. */
  async requestEmailChange(userId: string, newEmailRaw: string): Promise<void> {
    const newEmail = newEmailRaw.trim().toLowerCase();
    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: { email: true, status: true, tenantId: true },
    });
    if (!user || user.status !== 'active') {
      throw new BadRequestException('Account is not active.');
    }
    if (user.email && user.email.toLowerCase() === newEmail) {
      throw new BadRequestException('That is already your email address.');
    }
    // Pre-check uniqueness within the tenant (the unique index is the real
    // enforcer; this is a friendly early message). citext column → case-insensitive.
    const clash = await controlDb.user.findFirst({
      where: { tenantId: user.tenantId, email: newEmail, NOT: { id: userId } },
      select: { id: true },
    });
    if (clash) throw new BadRequestException('That email is already used by another account here.');

    const tenant = await this.tenantCtx(user.tenantId);
    if (!tenant) throw new BadRequestException('Library not found.');
    await this.send({
      userId,
      tenantId: user.tenantId,
      email: newEmail,
      slug: tenant.slug,
      locale: tenant.defaultLocale,
      libraryName: tenant.name,
      mode: 'change',
    });
  }

  // --- internals ---------------------------------------------------------

  private async sendWelcome(userId: string, tenantId: string, email: string): Promise<void> {
    const tenant = await this.tenantCtx(tenantId);
    if (!tenant) return;
    const base = `${loadEnv().publicAppUrl}/${tenant.defaultLocale}/t/${tenant.slug}`;
    const body = [
      `Welcome to ${tenant.name} on Libriant!`,
      ``,
      `Your email is verified and your library is ready. A few first steps:`,
      `  • Add your first books — ${base}/catalog`,
      `  • Add members — ${base}/members`,
      `  • Invite staff — ${base}/staff`,
      ``,
      `Happy cataloguing!`,
      ``,
      `— Libriant`,
    ].join('\n');
    try {
      await this.emails.enqueue({
        kind: 'welcome',
        toEmail: email,
        tenantId,
        idempotencyKey: `auth.welcome:${userId}`, // exactly once per account
        subject: `Welcome to ${tenant.name}`,
        bodyMarkdown: body,
        maxAttempts: 2,
        metadata: { userId },
      });
    } catch (err) {
      this.logger.warn(`welcome enqueue failed for user=${userId}: ${(err as Error).message}`);
    }
  }

  private async tenantCtx(
    tenantId: string,
  ): Promise<{ slug: string; name: string; defaultLocale: string } | null> {
    return controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true, name: true, defaultLocale: true },
    });
  }

  private async slugFor(tenantId: string): Promise<string | null> {
    const t = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    return t?.slug ?? null;
  }
}
