import { Controller, Delete, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { SupportKeyService } from './support-key.service.js';
import { SupportSessionService } from './support-session.service.js';

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
@UseGuards(TenantGuard)
export class LibrarySupportController {
  constructor(
    @Inject(SupportKeyService) private readonly keys: SupportKeyService,
    @Inject(SupportSessionService) private readonly sessions: SupportSessionService,
  ) {}

  @Post('keys')
  @HttpCode(200)
  async generate(@TenantCtx() tenant: TenantContext, @Sess() session: SessionPayload) {
    const key = await this.keys.generate({
      tenantId: tenant.id,
      createdByUserId: session.sub,
    });
    // We hand the plaintext code back exactly once — the librarian has
    // to copy it to chat with their Libriant support contact. We never
    // log it server-side.
    return {
      id: key.id,
      code: key.code,
      prefix: key.prefix,
      expiresAt: key.expiresAt,
    };
  }

  @Get('keys/pending')
  async pending(@TenantCtx() tenant: TenantContext) {
    return { key: await this.keys.pendingForTenant(tenant.id) };
  }

  @Delete('keys/pending')
  @HttpCode(204)
  async revoke(@TenantCtx() tenant: TenantContext) {
    await this.keys.revokePending(tenant.id);
  }

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
    // Auto-expire if past TTL.
    if (session.expiresAt < new Date()) {
      await this.sessions.end(session.id, 'expired');
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

  @Delete('sessions/active')
  @HttpCode(204)
  async revokeActive(@TenantCtx() tenant: TenantContext) {
    await this.sessions.endActiveForTenant(tenant.id, 'library_revoked');
  }

  @Get('sessions/log')
  async log(
    @TenantCtx() tenant: TenantContext,
    @Query('limit') limitRaw?: string,
    @Query('after') after?: string,
  ) {
    const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
    // Pull recent sessions for this tenant + their actions; tenant only
    // sees their own logs.
    const sessions = await controlDb.supportSession.findMany({
      where: { tenantId: tenant.id },
      orderBy: { startedAt: 'desc' },
      take: 25,
      include: {
        admin: { select: { email: true, fullName: true } },
        actions: {
          orderBy: { ts: 'desc' },
          take: limit,
          ...(after ? { cursor: { id: after }, skip: 1 } : {}),
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
