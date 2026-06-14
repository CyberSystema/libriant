import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { OpenSystemModeDto } from './system-mode.dto.js';
import { SystemModeService } from './system-mode.service.js';

/**
 * Admin control plane for system mode. Gated by `AdminAuthGuard`. The
 * routes here are intentionally exempted from the system-mode middleware
 * itself (see `ADMIN_BYPASS` in the middleware), so an admin can always
 * recover from a too-aggressive maintenance window.
 *
 *   GET    /admin/system-mode/current                     — current + per-tenant snapshot
 *   GET    /admin/system-mode/scheduled                   — windows starting in the future
 *   GET    /admin/system-mode/history?limit=              — past events
 *   POST   /admin/system-mode/global                      — open a global window
 *   POST   /admin/system-mode/tenants/:tenantId           — open a per-tenant window
 *   POST   /admin/system-mode/events/:id/end              — end an active window now
 *   DELETE /admin/system-mode/events/:id                  — cancel a SCHEDULED window
 */
@Controller('admin/system-mode')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminSystemModeController {
  constructor(@Inject(SystemModeService) private readonly modes: SystemModeService) {}

  @Get('current')
  async current() {
    const [global, active] = await Promise.all([
      this.modes.resolveGlobal(),
      this.modes.listActive(),
    ]);
    return {
      global,
      active: active.map((e) => ({
        id: e.id,
        scope: e.scope,
        tenant: e.tenant,
        mode: e.mode,
        messageMarkdown: e.messageMarkdown,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allowAdminBypass: e.allowAdminBypass,
        createdAt: e.createdAt,
        createdBy: e.createdByAdmin,
      })),
    };
  }

  @Get('scheduled')
  async scheduled() {
    const rows = await this.modes.listScheduled();
    return {
      scheduled: rows.map((e) => ({
        id: e.id,
        scope: e.scope,
        tenant: e.tenant,
        mode: e.mode,
        messageMarkdown: e.messageMarkdown,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        allowAdminBypass: e.allowAdminBypass,
        createdAt: e.createdAt,
        createdBy: e.createdByAdmin,
      })),
    };
  }

  @Get('history')
  async history(@Query('limit') limit?: string) {
    const rows = await this.modes.listHistory(Number(limit) || 50);
    return {
      history: rows.map((e) => ({
        id: e.id,
        scope: e.scope,
        tenant: e.tenant,
        mode: e.mode,
        messageMarkdown: e.messageMarkdown,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        endedAt: e.endedAt,
        allowAdminBypass: e.allowAdminBypass,
        createdBy: e.createdByAdmin,
      })),
    };
  }

  @Post('global')
  @AdminRoles('owner')
  @HttpCode(201)
  async openGlobal(@AdminSess() admin: AdminSessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(OpenSystemModeDto, raw);
    const event = await this.modes.openGlobal({
      mode: dto.mode,
      messageMarkdown: dto.messageMarkdown ?? null,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      allowAdminBypass: dto.allowAdminBypass ?? true,
      createdByAdminId: admin.sub,
    });
    return { event };
  }

  @Post('tenants/:tenantId')
  @AdminRoles('owner')
  @HttpCode(201)
  async openTenant(
    @AdminSess() admin: AdminSessionPayload,
    @Param('tenantId') tenantId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(OpenSystemModeDto, raw);
    const event = await this.modes.openTenant({
      tenantId,
      mode: dto.mode,
      messageMarkdown: dto.messageMarkdown ?? null,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      allowAdminBypass: dto.allowAdminBypass ?? true,
      createdByAdminId: admin.sub,
    });
    return { event };
  }

  @Post('events/:id/end')
  @AdminRoles('owner')
  @HttpCode(200)
  async end(@Param('id') id: string) {
    const event = await this.modes.endNow(id);
    return { event };
  }

  @Delete('events/:id')
  @AdminRoles('owner')
  @HttpCode(204)
  async cancel(@Param('id') id: string) {
    await this.modes.cancelScheduled(id);
  }
}
