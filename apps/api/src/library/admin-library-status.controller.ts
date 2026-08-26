import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { adminAuditActor, recordAdminAudit } from '../platform/admin-audit.js';
import { validateDto } from '../auth/validate-dto.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { SetLibraryStatusDto } from './library.dto.js';

/**
 * Pause / resume a library (platform owner-admin).
 *
 *   PUT /admin/tenants/:tenantId/status   { status: 'suspended' | 'active' }
 *
 * tenant-isolation-05: `tenants.status` is read on every single request —
 * TenantMiddleware answers 403 for `suspended` and 410 for `archived` — but
 * nothing in the product ever wrote it. Pausing a library for abuse, for
 * non-payment, or because the library itself asked us to stop processing, meant
 * an operator running `UPDATE tenants SET status='suspended'` by hand, and that
 * statement is invisible to every API and worker process for up to
 * TENANT_CACHE_TTL_SEC (300s) with nothing to tell the operator so: they watch
 * the library keep serving requests and reasonably conclude the pause failed.
 * The only tenant mutation on the admin surface until now was the irreversible
 * hard delete — which is a long way to go to stop processing for a week.
 *
 * The write goes through `TenantResolverService.updateTenant`, so the pause
 * takes effect on the next request everywhere, not in five minutes.
 */
@Controller('admin/tenants/:tenantId/status')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminLibraryStatusController {
  constructor(
    @Inject(TenantResolverService) private readonly tenantResolver: TenantResolverService,
  ) {}

  @Put()
  @AdminRoles('owner')
  @HttpCode(200)
  async set(
    @Param('tenantId') tenantId: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(SetLibraryStatusDto, raw);
    const current = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, status: true },
    });
    if (!current) throw new NotFoundException('Library not found.');
    // `archived` is deliberately not reachable from here, in either direction.
    // It answers 410 Gone rather than 403 and comes with an `archivedAt` stamp
    // and a retention decision behind it; un-archiving a library as a side
    // effect of a resume button would bring back records someone decided to put
    // beyond use. Archival and its reversal stay a deliberate, separate act.
    if (current.status === 'archived') {
      throw new BadRequestException(
        'This library is archived. Archiving and un-archiving are not done from here.',
      );
    }

    const updated = await this.tenantResolver.updateTenant(tenantId, { status: dto.status });
    await recordAdminAudit(adminAuditActor(req, admin), {
      tenantId: current.id,
      action: dto.status === 'suspended' ? 'tenant.suspended' : 'tenant.resumed',
      targetType: 'tenant',
      targetId: current.id,
      before: { status: current.status },
      after: { status: dto.status, reason: dto.reason ?? null },
    });
    return {
      tenant: { id: updated.id, slug: updated.slug, name: updated.name, status: updated.status },
    };
  }
}
