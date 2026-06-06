import { Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { AnnouncementDeliveryService } from './announcement-delivery.service.js';
import { controlDb } from '@libriant/db-control';

/**
 * Library-side announcement surface. Gated by the standard TenantGuard
 * so a logged-in librarian on the matching tenant is the only caller.
 *
 *   GET  /t/:slug/announcements/active
 *   POST /t/:slug/announcements/:id/dismiss
 *   POST /t/:slug/announcements/:id/ack
 *
 * Dismiss/ack semantics:
 *   - Dismissible non-ack announcements use a single per-tenant delivery
 *     row — any user on the tenant can dismiss for everyone.
 *   - Ack-required announcements use per-user delivery rows — each
 *     individual user has to acknowledge their own copy.
 */
@Controller('t/:slug/announcements')
@UseGuards(TenantGuard)
export class TenantAnnouncementsController {
  constructor(
    @Inject(AnnouncementDeliveryService)
    private readonly deliveries: AnnouncementDeliveryService,
  ) {}

  @Get('active')
  async active(@TenantCtx() tenant: TenantContext, @Sess() session: SessionPayload) {
    // Pull the user's email so the email outbox stub can address it.
    const u = await controlDb.user.findUnique({
      where: { id: session.sub },
      select: { email: true },
    });
    const items = await this.deliveries.activeForUser({
      tenantId: tenant.id,
      tenantTags: tenant.tags,
      tenantStatus: tenant.status,
      userId: session.sub,
      userEmail: u?.email ?? 'unknown@libriant.com',
    });
    return { announcements: items };
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  async dismiss(
    @Param('id') announcementId: string,
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
  ) {
    return this.deliveries.dismiss({
      announcementId,
      tenantId: tenant.id,
      userId: session.sub,
    });
  }

  @Post(':id/ack')
  @HttpCode(200)
  async ack(
    @Param('id') announcementId: string,
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
  ) {
    return this.deliveries.acknowledge({
      announcementId,
      tenantId: tenant.id,
      userId: session.sub,
    });
  }
}
