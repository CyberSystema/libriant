import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { audienceFromJson } from './audience.js';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './announcement.dto.js';
import { AnnouncementService } from './announcement.service.js';
import { AnnouncementDeliveryService } from './announcement-delivery.service.js';

/**
 *   GET    /admin/announcements?status=active|scheduled|expired|archived
 *   POST   /admin/announcements
 *   GET    /admin/announcements/:id
 *   PATCH  /admin/announcements/:id
 *   POST   /admin/announcements/:id/expire
 *   DELETE /admin/announcements/:id              (archive)
 *   GET    /admin/announcements/:id/stats
 *
 * All gated by AdminAuthGuard. Stats include both the LIVE audience count
 * (current matching tenants) and the historical delivery / dismissal /
 * ack counts — see {@link AnnouncementService.stats} for the why.
 */
@Controller('admin/announcements')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminAnnouncementsController {
  constructor(
    @Inject(AnnouncementService) private readonly anns: AnnouncementService,
    @Inject(AnnouncementDeliveryService)
    private readonly deliveries: AnnouncementDeliveryService,
  ) {}

  @Get()
  async list(@Query('status') status?: string, @Query('limit') limit?: string) {
    const normalized =
      status === 'scheduled' || status === 'expired' || status === 'archived' || status === 'active'
        ? status
        : undefined;
    return {
      announcements: await this.anns.list({
        status: normalized,
        limit: Number(limit) || undefined,
      }),
    };
  }

  @Post()
  @AdminRoles('owner')
  @HttpCode(201)
  async create(@AdminSess() admin: AdminSessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(CreateAnnouncementDto, raw);
    const ann = await this.anns.create({
      title: dto.title,
      bodyMarkdown: dto.bodyMarkdown,
      severity: dto.severity,
      audience: audienceFromJson(dto.audience),
      deliverInApp: dto.deliverInApp,
      deliverEmail: dto.deliverEmail,
      publishAt: dto.publishAt ? new Date(dto.publishAt) : null,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      dismissible: dto.dismissible,
      requiresAck: dto.requiresAck,
      createdByAdminId: admin.sub,
    });
    // Any tenant in the audience might be looking at the previous cached
    // active set — bust by resolving the live audience and busting each.
    await this.bustAudience(ann.id);
    return { announcement: ann };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { announcement: await this.anns.getById(id) };
  }

  @Patch(':id')
  @AdminRoles('owner')
  async update(@Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdateAnnouncementDto, raw);
    const ann = await this.anns.update(id, {
      title: dto.title,
      bodyMarkdown: dto.bodyMarkdown,
      severity: dto.severity,
      audience: dto.audience ? audienceFromJson(dto.audience) : undefined,
      deliverInApp: dto.deliverInApp,
      deliverEmail: dto.deliverEmail,
      publishAt:
        dto.publishAt === undefined ? undefined : dto.publishAt ? new Date(dto.publishAt) : null,
      expiresAt:
        dto.expiresAt === undefined ? undefined : dto.expiresAt ? new Date(dto.expiresAt) : null,
      dismissible: dto.dismissible,
      requiresAck: dto.requiresAck,
    });
    await this.bustAudience(ann.id);
    return { announcement: ann };
  }

  @Post(':id/expire')
  @AdminRoles('owner')
  @HttpCode(200)
  async expire(@Param('id') id: string) {
    const ann = await this.anns.expireNow(id);
    await this.bustAudience(ann.id);
    return { announcement: ann };
  }

  @Delete(':id')
  @AdminRoles('owner')
  @HttpCode(204)
  async archive(@Param('id') id: string) {
    const ann = await this.anns.archive(id);
    await this.bustAudience(ann.id);
  }

  @Get(':id/stats')
  async stats(@Param('id') id: string) {
    return { stats: await this.anns.stats(id) };
  }

  /**
   * Resolve the live audience for an announcement and bust each tenant's
   * cached active set. We could also bust everyone unconditionally, but
   * targeting only matched tenants keeps cache churn proportional to the
   * blast radius of the change.
   */
  private async bustAudience(announcementId: string): Promise<void> {
    const ann = await this.anns.getById(announcementId);
    const ids = await this.anns.resolveTargetTenantIds(ann.audience);
    await Promise.all(ids.map((tid) => this.deliveries.bustTenant(tid)));
  }
}
