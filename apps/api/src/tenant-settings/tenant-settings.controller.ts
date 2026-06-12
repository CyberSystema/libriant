import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { TenantSettingsService } from './tenant-settings.service.js';
import { UpdateTenantSettingsDto } from './tenant-settings.dto.js';

/**
 * Library policy + feature switches.
 *
 *   GET   /t/:slug/settings   — read (any staff; they need to see the policy)
 *   PATCH /t/:slug/settings   — change (owner/admin only)
 *
 * The switches here (overdue fines, lost-item fees, renewals, reservations)
 * are the library's own choice. Reservations additionally layer under the
 * subscription's `reservations_enabled` capability — see the service.
 */
@Controller('t/:slug/settings')
@UseGuards(TenantGuard, RolesGuard)
export class TenantSettingsController {
  constructor(@Inject(TenantSettingsService) private readonly svc: TenantSettingsService) {}

  @Get()
  async get(@TenantCtx() tenant: TenantContext) {
    return this.svc.get(tenant);
  }

  @Patch()
  @Roles('owner', 'admin')
  async update(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateTenantSettingsDto, raw);
    return this.svc.update(tenant, dto, actor);
  }
}
