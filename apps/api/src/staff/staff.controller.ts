import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { EmailVerifiedGuard } from '../auth/email-verified.guard.js';
import { QuotaInterceptor } from '../plans/quota.interceptor.js';
import { RequiresQuota } from '../plans/decorators.js';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { StaffService } from './staff.service.js';
import { CreateStaffDto, SetStaffRoleDto } from './staff.dto.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Library staff management — admin-only (owner/admin).
 *
 *   GET   /t/:slug/staff                  — list staff
 *   POST  /t/:slug/staff                  — create (returns one-time password)
 *   POST  /t/:slug/staff/:id/reset-password — new one-time password
 *   PATCH /t/:slug/staff/:id/role         — change role
 *   POST  /t/:slug/staff/:id/deactivate   — archive the account
 */
@Controller('t/:slug/staff')
@UseGuards(TenantGuard, PermissionGuard)
@UseInterceptors(QuotaInterceptor)
export class StaffController {
  constructor(@Inject(StaffService) private readonly svc: StaffService) {}

  @RequirePermission('admin.staff.manage')
  @Get()
  async list(@TenantCtx() tenant: TenantContext) {
    return { staff: await this.svc.list(tenant.id) };
  }

  @RequirePermission('admin.staff.manage')
  @Post()
  @HttpCode(201)
  // Inviting staff is verification-sensitive (it sends a new person credentials
  // tied to this library), so it's gated behind a verified owner/admin email.
  @UseGuards(EmailVerifiedGuard)
  @RequiresQuota('staff_seats')
  async create(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(CreateStaffDto, raw);
    return this.svc.create(tenant.id, { role: dto.role, fullName: dto.fullName });
  }

  @RequirePermission('admin.staff.manage')
  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.resetPassword(tenant.id, id);
  }

  @RequirePermission('admin.staff.manage')
  @Patch(':id/role')
  @HttpCode(200)
  async setRole(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(SetStaffRoleDto, raw);
    await this.svc.setRole(tenant.id, id, dto.role);
    return { ok: true };
  }

  @RequirePermission('admin.staff.manage')
  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Param('id') id: string,
  ) {
    await this.svc.deactivate(tenant.id, id, session.sub);
    return { ok: true };
  }
}
