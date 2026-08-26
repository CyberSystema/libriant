import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { controlDb, type EmailMessageKind, type EmailOutboxStatus } from '@libriant/db-control';
import { loadEnv } from '../config/env.js';
import {
  outboxSecretKey,
  parseSecretPayload,
  sealedRef,
  unsealBody,
} from '../email/outbox-secrets.js';
import { RedisService } from '../platform/redis.service.js';
import { tokenKey } from '../auth/token-digest.js';

/**
 * The operator's escape hatch for launch-readiness-01.
 *
 * Libriant launches with `EMAIL_DRIVER=console` and no mail provider. Every
 * message is composed, queued, written to `email_outbox` and marked delivered
 * against a fabricated provider id — and then goes nowhere. Before this
 * service the body was also withheld from the log, so a librarian who needed a
 * verification or reset link had no path to one and neither did the operator:
 * the only recovery was an undocumented `select "bodyMarkdown" from
 * email_outbox` in psql, inside the token's TTL.
 *
 * Three supported paths replace that:
 *
 *   1. READ what would have been sent (`list` / `detail`). `detail` re-hydrates
 *      the one-time link from Redis so the operator can read it out over the
 *      phone or paste it into a reply.
 *   2. VERIFY an address without the emailed link (`forceVerifyEmail`) — the
 *      path that unblocks `EmailVerifiedGuard`, and therefore unblocks a
 *      library hiring its second member of staff.
 *   3. MINT a fresh password-reset link (`issuePasswordResetLink`) for the
 *      library OWNER, who — unlike staff, who have an in-app reset at
 *      `POST /t/:slug/staff/:id/reset-password` — has no other way back in.
 *
 * ALL THREE ARE ACCOUNT-TAKEOVER PRIMITIVES. That is not a side effect, it is
 * what "the operator can get a librarian back into their library" means. The
 * containment is: owner-level platform admin only (support-tier admins are
 * excluded — reading a live reset link is strictly more powerful than the
 * support-key flow those admins are supposed to go through), MFA already
 * enforced by AdminAuthGuard, and an `audit_log` row for every single call
 * including the reads. Written by the controller, which has the request.
 */
@Injectable()
export class AdminOutboxService {
  private readonly logger = new Logger(AdminOutboxService.name);

  /**
   * Must match `PasswordResetService.TOKEN_TTL_SEC` and the `{uid,tid}` payload
   * that `PasswordResetService.complete()` reads back. This is duplicated rather
   * than imported because the auth service exposes no mint-only entry point
   * (its `request()` is the anti-enumeration public flow: rate-limited, silent,
   * and it enqueues an email that will not be delivered).
   *
   * The KEY shape is no longer duplicated: both sides call `tokenKey()`, so the
   * digest-at-rest of authn-authz-11 cannot hold on one path and not the other.
   *
   * The duplication is CHECKED, not trusted:
   * `apps/api/test/integration/email-escape-hatch.spec.ts` mints a link through
   * the real HTTP route, redeems it through the real
   * `POST /auth/password-reset/complete` and then signs in with the new
   * password, so a change to either side fails the build instead of silently
   * producing links that 400. (That spec was claimed here once before it
   * existed. It exists now — `ls apps/api/test/integration/` before you trust
   * this paragraph again.)
   */
  private static readonly RESET_TOKEN_TTL_SEC = 60 * 60;

  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  /**
   * Envelope-only listing. Deliberately WITHOUT the body: the list is the
   * everyday view ("did the overdue run go out?") and it should not spray
   * message prose — or a re-hydrated one-time link — across a page that gets
   * left open on a laptop. Reading a body is a separate, audited click.
   */
  async list(filter: {
    status?: string;
    kind?: string;
    tenantSlug?: string;
    q?: string;
    limit?: number;
  }) {
    const limit = Math.max(1, Math.min(200, filter.limit || 50));
    const where: Record<string, unknown> = {};
    if (filter.status) where.status = filter.status as EmailOutboxStatus;
    if (filter.kind) where.kind = filter.kind as EmailMessageKind;
    if (filter.tenantSlug) where.tenant = { slug: filter.tenantSlug.toLowerCase() };
    if (filter.q && filter.q.trim().length) {
      const q = filter.q.trim();
      where.OR = [
        { toEmail: { contains: q.toLowerCase() } },
        { subject: { contains: q, mode: 'insensitive' } },
      ];
    }

    const rows = await controlDb.emailOutbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        kind: true,
        toEmail: true,
        subject: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        scheduledFor: true,
        deliveredAt: true,
        createdAt: true,
        tenant: { select: { slug: true, name: true } },
      },
    });

    return {
      // The panel says out loud whether anything is actually being sent, so a
      // green "delivered" column can never be read as "the librarian got it".
      driver: loadEnv().emailDriver,
      delivering: loadEnv().emailDriver !== 'console',
      messages: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        toEmail: r.toEmail,
        subject: r.subject,
        status: r.status,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        lastError: r.lastError,
        scheduledFor: r.scheduledFor,
        deliveredAt: r.deliveredAt,
        createdAt: r.createdAt,
        tenantSlug: r.tenant?.slug ?? null,
        tenantName: r.tenant?.name ?? null,
      })),
    };
  }

  /**
   * One message, body included, with any sealed one-time link put back.
   *
   * `linkState` is the honest part. `expired` means the sealed value outlived
   * its TTL — the operator is shown `[link expired]` instead of a URL, because
   * a URL whose token has already died is worse than no URL: it sends the
   * librarian round a loop that ends in "this link is invalid".
   */
  async detail(id: string) {
    const row = await controlDb.emailOutbox.findUnique({
      where: { id },
      select: {
        id: true,
        kind: true,
        toEmail: true,
        fromEmail: true,
        replyToEmail: true,
        subject: true,
        bodyMarkdown: true,
        status: true,
        attempts: true,
        maxAttempts: true,
        lastError: true,
        providerId: true,
        scheduledFor: true,
        deliveredAt: true,
        failedAt: true,
        createdAt: true,
        metadataJson: true,
        tenantId: true,
        tenant: { select: { slug: true, name: true } },
      },
    });
    if (!row) throw new NotFoundException('No such message.');

    const ref = sealedRef(row.bodyMarkdown);
    let linkState: 'none' | 'live' | 'expired' = 'none';
    let body = row.bodyMarkdown;
    if (ref) {
      const raw = await this.redis.client.get(outboxSecretKey(ref)).catch(() => null);
      const unsealed = unsealBody(row.bodyMarkdown, parseSecretPayload(raw));
      body = unsealed.body;
      linkState = unsealed.missing > 0 ? 'expired' : 'live';
    }

    return {
      id: row.id,
      kind: row.kind,
      toEmail: row.toEmail,
      fromEmail: row.fromEmail,
      replyToEmail: row.replyToEmail,
      subject: row.subject,
      body,
      linkState,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastError: row.lastError,
      providerId: row.providerId,
      scheduledFor: row.scheduledFor,
      deliveredAt: row.deliveredAt,
      failedAt: row.failedAt,
      createdAt: row.createdAt,
      metadata: row.metadataJson,
      // Returned for the AUDIT WRITE, not for the panel (privacy-legal-04):
      // the controller stamps this on the `email_outbox.body.read` row so it
      // belongs to a tenant, and is therefore reached by both the delete
      // CASCADE and the BEFORE DELETE redaction trigger — which key on
      // `tenantId` and skip NULL rows entirely.
      tenantId: row.tenantId,
      tenantSlug: row.tenant?.slug ?? null,
      tenantName: row.tenant?.name ?? null,
      driver: loadEnv().emailDriver,
      delivering: loadEnv().emailDriver !== 'console',
    };
  }

  /**
   * Find the account the operator is on the phone with. Matches email,
   * username or full name within an optional library. No pagination: the
   * operator is looking for one person they can already name, and a wide
   * result set here would just be a directory dump.
   */
  async findUsers(query: string, tenantSlug?: string) {
    const q = query.trim();
    if (q.length < 2) {
      throw new BadRequestException('Type at least two characters to search.');
    }
    const rows = await controlDb.user.findMany({
      where: {
        ...(tenantSlug ? { tenant: { slug: tenantSlug.toLowerCase() } } : {}),
        OR: [
          { email: { contains: q.toLowerCase() } },
          { username: { contains: q.toLowerCase() } },
          { fullName: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        lockedUntil: true,
        archivedAt: true,
        tenant: { select: { slug: true, name: true } },
      },
    });
    return {
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        fullName: u.fullName,
        role: u.role,
        status: u.status,
        emailVerified: u.emailVerifiedAt !== null,
        emailVerifiedAt: u.emailVerifiedAt,
        locked: u.lockedUntil !== null && u.lockedUntil.getTime() > Date.now(),
        archived: u.archivedAt !== null,
        tenantSlug: u.tenant.slug,
        tenantName: u.tenant.name,
      })),
    };
  }

  /**
   * Mark an address verified without the emailed link.
   *
   * This is the one that unblocks the product. `EmailVerifiedGuard` sits on
   * `POST /t/:slug/staff`, `users.emailVerifiedAt` is written in exactly one
   * place (`EmailVerificationService.verify`, reachable only by redeeming a
   * token that arrives by email), and with the console driver that token never
   * arrives — so a brand-new library could never add its second librarian.
   * Signup → invite a colleague is the core onboarding path of a library
   * product; it cannot terminate in a 403 with no exit.
   *
   * Idempotent: verifying an already-verified address is a no-op that reports
   * `alreadyVerified` rather than an error, so an operator repeating themselves
   * during a phone call does not get a scary red banner.
   */
  async forceVerifyEmail(userId: string) {
    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        status: true,
        emailVerifiedAt: true,
        tenant: { select: { id: true, slug: true, name: true } },
      },
    });
    if (!user) throw new NotFoundException('No such user.');
    if (!user.email) {
      // Staff accounts sign in with a username and have no address on file.
      // EmailVerifiedGuard already treats them as exempt, so "verifying" one
      // would write a timestamp that means nothing.
      throw new BadRequestException(
        'This account signs in with a username and has no email address to verify.',
      );
    }
    if (user.emailVerifiedAt) {
      return {
        alreadyVerified: true,
        userId: user.id,
        email: user.email,
        verifiedAt: user.emailVerifiedAt,
        tenantId: user.tenant.id,
        tenantSlug: user.tenant.slug,
      };
    }

    const verifiedAt = new Date();
    await controlDb.user.update({ where: { id: user.id }, data: { emailVerifiedAt: verifiedAt } });
    this.logger.warn(
      `email for user ${user.id} (${user.tenant.slug}) force-verified by an operator — ` +
        `no confirmation link was redeemed`,
    );
    return {
      alreadyVerified: false,
      userId: user.id,
      email: user.email,
      verifiedAt,
      tenantId: user.tenant.id,
      tenantSlug: user.tenant.slug,
    };
  }

  /**
   * Mint a one-time password-reset link and RETURN it in the HTTP response,
   * instead of mailing it into a void.
   *
   * No email is enqueued on purpose: the whole reason this endpoint exists is
   * that mail does not leave the box, and queueing a second undeliverable copy
   * of the same link would only widen the window in which a live token sits in
   * a row somewhere. The operator reads the URL back to the person who asked
   * for it, and they set their own password — the operator never learns the
   * resulting credential, and `complete()` bumps `sessionsValidAfter`, so any
   * session an attacker already held dies with the reset.
   */
  async issuePasswordResetLink(userId: string) {
    const user = await controlDb.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        fullName: true,
        status: true,
        tenant: { select: { id: true, slug: true, name: true, status: true, defaultLocale: true } },
      },
    });
    if (!user) throw new NotFoundException('No such user.');
    // Mirror PasswordResetService.complete()'s own guard (`status: 'active'`),
    // so we can't hand out a link that is guaranteed to fail at redemption.
    if (user.status !== 'active') {
      throw new BadRequestException(
        `This account is "${user.status}" — activate it before issuing a reset link.`,
      );
    }
    if (user.tenant.status !== 'active') {
      throw new BadRequestException(`The library "${user.tenant.slug}" is not active.`);
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + AdminOutboxService.RESET_TOKEN_TTL_SEC * 1000);
    await this.redis.client.set(
      tokenKey('pwreset', token),
      JSON.stringify({ uid: user.id, tid: user.tenant.id }),
      'EX',
      AdminOutboxService.RESET_TOKEN_TTL_SEC,
    );
    const env = loadEnv();
    // THE PATH MUST BE A ROUTE THE WEB APP ACTUALLY SERVES. It was not, for two
    // rounds of remediation: this composed `/<locale>/login/reset?...` while
    // apps/web had no `login/reset` page, so the operator read out a URL that
    // 404'd and the only way to spend a valid token was a hand-built curl.
    // `apps/api/test/integration/email-escape-hatch.spec.ts` now asserts that
    // the page file backing this path exists on disk.
    //
    // THE TOKEN GOES IN THE FRAGMENT, NOT THE QUERY (privacy-legal-06). Caddy's
    // site-wide `log { format json }` records `request.uri` — query string
    // included — and scripts/backup.sh tars /var/log/caddy into the nightly
    // backup, so `?token=` would put a live credential in a log file and in
    // every off-site copy of it. Everything after `#` is never sent to the
    // server. The landing page reads the fragment first and the query second,
    // so links minted before this change still work.
    const url =
      `${env.publicAppUrl}/${user.tenant.defaultLocale}/login/reset` +
      `#token=${token}&slug=${user.tenant.slug}`;

    this.logger.warn(
      `password-reset link issued out-of-band for user ${user.id} (${user.tenant.slug}) — ` +
        `expires ${expiresAt.toISOString()}`,
    );
    return {
      url,
      expiresAt,
      userId: user.id,
      tenantId: user.tenant.id,
      tenantSlug: user.tenant.slug,
      // Echoed so the operator can read back who they just issued this for
      // before they paste it anywhere.
      identity: user.email ?? user.username ?? user.fullName,
    };
  }
}
