import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { parseLimit } from '../platform/query.js';
import { AuditService } from './audit.service.js';

/**
 * Read-only activity log for the library's own data changes (members, loans,
 * fines, settings…). Admin-only — it's an oversight tool, not day-to-day work.
 *
 *   GET /t/:slug/audit?action=&after=&limit=
 */
@Controller('t/:slug/audit')
@UseGuards(TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class AuditController {
  constructor(@Inject(AuditService) private readonly svc: AuditService) {}

  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Query('action') action?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.list(tenant, {
      action: action && action.length ? action : undefined,
      after: after && after.length ? after : undefined,
      limit: parseLimit(limit),
    });
  }
}
