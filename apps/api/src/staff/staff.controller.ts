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
} from '@nestjs/common';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { StaffService } from './staff.service.js';
import { CreateStaffDto, SetStaffRoleDto } from './staff.dto.js';

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
@UseGuards(TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class StaffController {
  constructor(@Inject(StaffService) private readonly svc: StaffService) {}

  @Get()
  async list(@TenantCtx() tenant: TenantContext) {
    return { staff: await this.svc.list(tenant.id) };
  }

  @Post()
  @HttpCode(201)
  async create(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(CreateStaffDto, raw);
    return this.svc.create(tenant.id, { role: dto.role, fullName: dto.fullName });
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  async resetPassword(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.resetPassword(tenant.id, id);
  }

  @Patch(':id/role')
  @HttpCode(200)
  async setRole(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(SetStaffRoleDto, raw);
    await this.svc.setRole(tenant.id, id, dto.role);
    return { ok: true };
  }

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
