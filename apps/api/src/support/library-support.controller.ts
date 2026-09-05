import { Controller, Delete, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { SupportKeyService } from './support-key.service.js';
import { SupportNotificationsService } from './support-notifications.service.js';
import { SupportSessionService } from './support-session.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Library-side surface of the support flow. Lives at
 * `/t/:slug/support/...` so it inherits the same TenantGuard the rest of
 * the tenant API uses — the librarian must be signed in to the right
 * tenant to issue a key.
 *
 *   POST   /t/:slug/support/keys                — generate one-time key
 *   GET    /t/:slug/support/keys/pending        — metadata about the open key (no code)
 *   DELETE /t/:slug/support/keys/pending        — revoke the open key
 *   GET    /t/:slug/support/sessions/active     — active impersonation session for this tenant
 *   DELETE /t/:slug/support/sessions/active     — library "end support access"
 *   GET    /t/:slug/support/sessions/log        — audit log (most recent first)
 */
@Controller('t/:slug/support')
@UseGuards(TenantGuard, PermissionGuard)
export class LibrarySupportController {
  constructor(
    @Inject(SupportKeyService) private readonly keys: SupportKeyService,
    @Inject(SupportSessionService) private readonly sessions: SupportSessionService,
    @Inject(SupportNotificationsService) private readonly notifs: SupportNotificationsService,
  ) {}

  @RequirePermission('support.key.manage')
  @Post('keys')
  @HttpCode(200)
  async generate(@TenantCtx() tenant: TenantContext, @Sess() session: SessionPayload) {
    const key = await this.keys.generate({
      tenantId: tenant.id,
      createdByUserId: session.sub,
    });
    // We hand the plaintext code back exactly once — the librarian has
    // to copy it to chat with their Libriant support contact. We never
    // log it server-side. The notification email omits the plaintext
    // entirely; it only echoes the 4-char prefix so the recipient can
    // recognise the key in support chat without disclosing the secret.
    await this.notifs.keyGenerated({
      keyId: key.id,
      tenantId: tenant.id,
      prefix: key.prefix,
      expiresAt: key.expiresAt,
      createdByUserId: session.sub,
    });
    return {
      id: key.id,
      code: key.code,
      prefix: key.prefix,
      expiresAt: key.expiresAt,
    };
  }

  @RequirePermission('support.key.manage')
  @Get('keys/pending')
  async pending(@TenantCtx() tenant: TenantContext) {
    return { key: await this.keys.pendingForTenant(tenant.id) };
  }

  @RequirePermission('support.key.manage')
  @Delete('keys/pending')
  @HttpCode(204)
  async revoke(@TenantCtx() tenant: TenantContext) {
    await this.keys.revokePending(tenant.id);
  }

  @RequirePermission('support.session.read')
  @Get('sessions/active')
  async activeSession(@TenantCtx() tenant: TenantContext) {
    const session = await controlDb.supportSession.findFirst({
      where: { tenantId: tenant.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
      include: {
        admin: { select: { id: true, email: true, fullName: true } },
      },
    });
    if (!session) return { session: null };
    // Auto-expire if past TTL. Fire the same notification flow the admin
    // path does so the library hears about it through one channel.
    if (session.expiresAt < new Date()) {
      const ended = await this.sessions.end(session.id, 'expired');
      if (ended) {
        await this.notifs.sessionEnded({
          sessionId: ended.id,
          tenantId: ended.tenantId,
          endedReason: 'expired',
          actionCount: ended.actionCount,
        });
      }
      return { session: null };
    }
    return {
      session: {
        id: session.id,
        startedAt: session.startedAt,
        expiresAt: session.expiresAt,
        admin: session.admin,
      },
    };
  }

  @RequirePermission('support.session.revoke')
  @Delete('sessions/active')
  @HttpCode(204)
  async revokeActive(@TenantCtx() tenant: TenantContext) {
    const ended = await this.sessions.endActiveForTenant(tenant.id, 'library_revoked');
    // Fire one notification per session that we actually ended (under
    // the at-most-one-active invariant this is 0 or 1; loop is
    // defensive for the rare double-active edge).
    for (const e of ended) {
      await this.notifs.sessionEnded({
        sessionId: e.id,
        tenantId: e.tenantId,
        endedReason: 'library_revoked',
        actionCount: e.actionCount,
      });
    }
  }

  @RequirePermission('support.session.read')
  @Get('sessions/log')
  async log(@TenantCtx() tenant: TenantContext, @Query('limit') limitRaw?: string) {
    const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
    // performance-03. This used to take an `?after=` cursor and hand it to the
    // NESTED `actions` read as `cursor: { id: after }, skip: 1`. Two things
    // were wrong with that, and neither is fixable while ONE cursor has to
    // serve twenty-five different sessions' action lists.
    //
    // Reproduced on the identical Prisma code path — a parent `findMany(take:
    // N)` whose included child relation is ordered DESC by a timestamp and
    // carries `take` + `cursor` + `skip: 1` — with the query event log on:
    //
    //   1. NO LIMIT IS EMITTED. Prisma renders
    //        SELECT … WHERE "sessionId" IN ($1…$25)
    //          AND "ts" <= (SELECT "ts" FROM … WHERE id = $26)
    //        ORDER BY "ts" DESC OFFSET $27
    //      and trims each parent's rows in the client. Every "next page" pulls
    //      the whole matching action history of all twenty-five sessions across
    //      the wire to render `limit` rows — the same shape as performance-10
    //      on the holds screen.
    //   2. EVERY PARENT COMES BACK EMPTY. The cursor row belongs to one
    //      session, so Prisma finds no cursor position in any of the others and
    //      returns nothing for them — and in the reproduction, nothing for the
    //      anchor's own parent either: all five parents returned zero children.
    //      A library owner paging their support log would have watched every
    //      session's worth of evidence disappear, which is the opposite of what
    //      an audit log is for.
    //
    // Nothing ever sent it: the only caller is the support-access page
    // (apps/web/app/[locale]/t/[slug]/settings/support-access/page.tsx), which
    // requests `/support/sessions/log` with no query string at all. So the
    // parameter is gone rather than reworked into a per-session pager with no
    // caller. `limit` stays: it caps the actions returned per session.
    const sessions = await controlDb.supportSession.findMany({
      where: { tenantId: tenant.id },
      orderBy: { startedAt: 'desc' },
      take: 25,
      include: {
        admin: { select: { email: true, fullName: true } },
        actions: {
          // `ts` alone is not a total order — a support session fires several
          // requests inside the same millisecond — so two page loads could
          // order the same actions differently. `id` settles it.
          orderBy: [{ ts: 'desc' }, { id: 'desc' }],
          take: limit,
          select: {
            id: true,
            ts: true,
            method: true,
            path: true,
            status: true,
            targetType: true,
            targetId: true,
          },
        },
      },
    });
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        expiresAt: s.expiresAt,
        endedAt: s.endedAt,
        endedReason: s.endedReason,
        admin: s.admin,
        actions: s.actions,
      })),
    };
  }
}
