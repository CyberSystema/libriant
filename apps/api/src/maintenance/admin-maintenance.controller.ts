import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { MaintenanceService } from './maintenance.service.js';
import { StartMaintenanceDto } from './maintenance.dto.js';

/**
 * Operator maintenance control plane (admin-only).
 *
 *   GET  /admin/maintenance            — recent runs (poll for progress)
 *   GET  /admin/maintenance/tenants    — id/slug/name list for the picker
 *   GET  /admin/maintenance/:id        — one run (poll for progress)
 *   POST /admin/maintenance            — launch { kind, scope, tenantId? }
 *
 * Launching only enqueues — the worker runs the job and writes progress +
 * results back onto the run row, which the UI polls.
 */
@Controller('admin/maintenance')
@UseGuards(AdminAuthGuard)
export class AdminMaintenanceController {
  constructor(@Inject(MaintenanceService) private readonly svc: MaintenanceService) {}

  @Get()
  async list(@Query('limit') limit?: string) {
    return { runs: await this.svc.list(Number(limit) || 25) };
  }

  @Get('tenants')
  async tenants() {
    const rows = await controlDb.tenant.findMany({
      where: { archivedAt: null },
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, name: true },
    });
    return { tenants: rows };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return { run: await this.svc.get(id) };
  }

  @Post()
  @HttpCode(202)
  async start(@AdminSess() admin: AdminSessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(StartMaintenanceDto, raw);
    const run = await this.svc.start({
      kind: dto.kind,
      scope: dto.scope,
      tenantId: dto.tenantId,
      adminId: admin.sub,
    });
    return { run };
  }
}
