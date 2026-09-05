import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { DashboardService, type TenantSummary } from './dashboard.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 *   GET /t/:slug/summary
 *
 * The tenant home page's tiles in one call (performance-11). Read-only, so no
 * `@StaffWrite` — every staff role that can see the dashboard can see these
 * five numbers, and they are the same numbers the list screens behind each tile
 * would show.
 */
@Controller('t/:slug/summary')
@UseGuards(TenantGuard, PermissionGuard)
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly svc: DashboardService) {}

  @RequirePermission('report.dashboard.read')
  @Get()
  async summary(@TenantCtx() tenant: TenantContext): Promise<TenantSummary> {
    return this.svc.summary(tenant);
  }
}
