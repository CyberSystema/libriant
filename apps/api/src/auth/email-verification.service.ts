import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { controlDb, Prisma } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import { EmailService } from '../email/email.service.js';
import { RateLimitService } from '../platform/rate-limit.service.js';
import { RedisService } from '../platform/redis.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { PasswordService } from './password.service.js';
import { SessionRevocationService } from './session-revocation.service.js';

/** What we stash in Redis under the one-time verification token. */
type VerifyPayload = {
  uid: string;
  tid: string;
  /** The address being confirmed. For `signup` it's the current email; for
   *  `change` it's the NEW address that becomes the email once confirmed. */
  email: string;
  mode: 'signup' | 'change';
  /**
   * `change` only: the address the account held when the change was STAGED,
   * lowercased (`null` for a staff account that had none).
   *
   * authn-authz-08: the apply step was
   * `updateMany({ where: { id, tenantId }, data: { email } })` — it never
   * checked that the account still had the address the token was issued
   * against, unlike the `signup` branch three lines below it which does pin
   * `email` in the where-clause. So a token staged before the owner recovered
   * their account still landed afterwards, quietly re-taking it.
   */
  prevEmail?: string | null;
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
 *   requestEmailChange()  — re-prove the password, warn the OLD address + the
 *                           library's audit log, then send a verify link to the
 *                           NEW address; the account email only changes once
 *                           that link is clicked (authn-authz-08).
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
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(SessionRevocationService) private readonly revocations: SessionRevocationService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(TenantResolverService) private readonly tenants: TenantResolverService,
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
    /** `change` only — pinned into the token, see {@link VerifyPayload.prevEmail}. */
    prevEmail?: string | null;
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
      ...(input.mode === 'change' ? { prevEmail: input.prevEmail ?? null } : {}),
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
        // authn-authz-08: pin the PRIOR address in the where-clause. A token
        // staged against `old@lib.gr` must be inert once the account no longer
        // holds that address — otherwise a change staged during a stolen
        // session lands silently after the owner has recovered. `prevEmail` is
        // undefined only for a token minted before this claim existed; those
        // keep the old (unpinned) behaviour for their remaining 24h TTL rather
        // than failing every in-flight change on deploy.
        const where =
          p.prevEmail === undefined
            ? { id: p.uid, tenantId: p.tid }
            : { id: p.uid, tenantId: p.tid, email: p.prevEmail };
        const upd = await controlDb.user.updateMany({
          where,
          data: {
            email: p.email,
            emailVerifiedAt: new Date(),
            // Every session dies when the address changes. This is the control
            // that breaks the takeover chain: the attacker's borrowed cookie
            // stops working the moment the change lands, and the real owner is
            // signed out — which is the signal that something happened, on a
            // platform where no mail is delivered.
            sessionsValidAfter: new Date(),
          },
        });
        if (upd.count !== 1) return { ok: false };
        // The column above is written atomically with the address so a crash
        // can't leave the change applied and the sessions alive; this call is
        // what drops AuthGuard's 60s positive-revalidation cache so it bites on
        // the very next request rather than up to a minute later.
        await this.revocations.revokeAllForUser(p.uid, 'account email changed');
        await this.recordEmailAudit(p.tid, p.uid, 'account.email_changed', {
          from: p.prevEmail ?? null,
          to: p.email,
        });
        return { ok: true, mode: 'change', slug };
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

  /**
   * Stage an email change: re-prove the password, notify the address being
   * left, then send a verify link to the NEW address.
   *
   * authn-authz-08. Three things happen here that did not before, and each one
   * is load-bearing on its own:
   *
   *   1. `currentPassword` is verified. Without it, a session cookie alone
   *      re-pointed the account, which is a full takeover of a library owner
   *      when chained with an un-revocable logout.
   *   2. The OLD address is told, and — because EMAIL_DRIVER is `console` and
   *      nothing is delivered — the same fact is written to the library's own
   *      audit log, which owners and admins read at Settings → Activity. A
   *      notice that only exists in an undeliverable mail queue is not a notice.
   *   3. The address the account holds RIGHT NOW is pinned into the token, so
   *      the staged change cannot land against a different one later.
   */
  async requestEmailChange(
    userId: string,
    newEmailRaw: string,
    currentPassword: string,
  ): Promise<void> {
    const newEmail = newEmailRaw.trim().toLowerCase();
    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: { email: true, status: true, tenantId: true, passwordHash: true },
    });
    if (!user || user.status !== 'active') {
      throw new BadRequestException('Account is not active.');
    }
    // Step-up. Uniform-time on the no-hash path for the same reason login is:
    // an account without a password must not answer faster than one with.
    // A machine `code` so the web can say "that password is wrong" rather than
    // the generic 401 copy, which reads as "please sign in" and is the wrong
    // instruction for someone who IS signed in.
    const wrongPassword = () =>
      new UnauthorizedException({ code: 'auth.wrongPassword', message: 'That password is wrong.' });
    if (!user.passwordHash) {
      await this.passwords.dummyVerify(currentPassword);
      throw wrongPassword();
    }
    if (!(await this.passwords.verify(currentPassword, user.passwordHash))) {
      throw wrongPassword();
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
    const prevEmail = user.email ? user.email.toLowerCase() : null;
    await this.send({
      userId,
      tenantId: user.tenantId,
      email: newEmail,
      slug: tenant.slug,
      locale: tenant.defaultLocale,
      libraryName: tenant.name,
      mode: 'change',
      prevEmail,
    });
    // Only after the link is actually issued — telling someone their address is
    // being taken when nothing was staged would be its own kind of alarm.
    await this.notifyPreviousAddress(user.tenantId, userId, prevEmail, newEmail, tenant.name);
    await this.recordEmailAudit(user.tenantId, userId, 'account.email_change_requested', {
      from: prevEmail,
      to: newEmail,
    });
  }

  // --- internals ---------------------------------------------------------

  /**
   * Tell the address that is about to STOP being the account's, that it is.
   *
   * Best-effort: the change has already been staged, and a mail-queue problem
   * must not turn a legitimate address change into a 500. `enqueue` writes a
   * row to `email_outbox` even when nothing is delivered, so the operator's
   * escape hatch at /admin/outbox (launch-readiness-01) holds the notice even
   * with EMAIL_DRIVER=console — but that surface belongs to Libriant, not to
   * the library, which is why {@link recordEmailAudit} runs as well.
   */
  private async notifyPreviousAddress(
    tenantId: string,
    userId: string,
    prevEmail: string | null,
    newEmail: string,
    libraryName: string,
  ): Promise<void> {
    if (!prevEmail) return; // staff account with no address to warn
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const body = [
      `Someone asked to change the email address on your ${libraryName} account.`,
      ``,
      `  From: ${prevEmail}`,
      `  To:   ${newEmail}`,
      ``,
      `The change is NOT active yet — it only takes effect when the link we sent to the new`,
      `address is opened. When it does, every device signed in to this account is signed out.`,
      ``,
      `If this was not you, change your password now: whoever asked for this knew it.`,
      `Your library's owner can also see this request under Settings → Activity.`,
      ``,
      `— Libriant`,
    ].join('\n');
    try {
      await this.emails.enqueue({
        kind: 'transactional',
        toEmail: prevEmail,
        tenantId,
        idempotencyKey: `auth.email_change_notice:${userId}:${minuteBucket}`,
        subject: `Security notice: an email change was requested on your ${libraryName} account`,
        bodyMarkdown: body,
        maxAttempts: 3,
        metadata: { userId, kind: 'email_change_notice' },
      });
    } catch (err) {
      this.logger.warn(
        `email-change notice to the previous address failed for user=${userId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Write the event to the LIBRARY's own audit log — the surface a library
   * owner or admin can actually reach, at Settings → Activity
   * (`GET /t/:slug/audit`, owner/admin only).
   *
   * This exists because of a constraint, not a preference: EMAIL_DRIVER is
   * `console` and there is no delivery provider, so "notify the old address"
   * cannot be the whole answer to authn-authz-08. Best-effort like every other
   * audit write (tenant-audit.service.ts) — losing the row must not fail the
   * request that produced it.
   */
  private async recordEmailAudit(
    tenantId: string,
    userId: string,
    action: 'account.email_change_requested' | 'account.email_changed',
    detail: { from: string | null; to: string },
  ): Promise<void> {
    try {
      const slug = await this.slugFor(tenantId);
      if (!slug) return;
      const ctx = await this.tenants.resolveBySlug(slug);
      if (!ctx) return;
      await this.audit.record(
        ctx,
        { userId, actorId: userId, actorType: 'user', supportSessionId: null },
        { action, targetType: 'user', targetId: userId, after: detail },
      );
    } catch (err) {
      this.logger.warn(
        `email-change audit write failed for user=${userId}: ${(err as Error).message}`,
      );
    }
  }

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
