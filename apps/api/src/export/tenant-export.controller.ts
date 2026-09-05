import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { ExportService, publicExportJob } from './export.service.js';
import { CreateTenantExportDto } from './export.dto.js';
import { streamExport } from './export-download.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Library-admin export of THEIR library's database (admin-only).
 *
 *   GET  /t/:slug/exports               — recent exports
 *   POST /t/:slug/exports               — start one ({ format })
 *   GET  /t/:slug/exports/:id/download  — download the produced file
 */
@Controller('t/:slug/exports')
@UseGuards(TenantGuard, PermissionGuard)
export class TenantExportController {
  constructor(@Inject(ExportService) private readonly svc: ExportService) {}

  @RequirePermission('admin.export.manage')
  @Get()
  async list(@TenantCtx() tenant: TenantContext) {
    return { exports: (await this.svc.listForTenant(tenant.id)).map(publicExportJob) };
  }

  @RequirePermission('admin.export.manage')
  @Post()
  @HttpCode(202)
  async create(
    @TenantCtx() tenant: TenantContext,
    @Sess() session: SessionPayload,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateTenantExportDto, raw);
    const job = await this.svc.createForTenant(tenant.id, session.sub, dto.format);
    return { export: publicExportJob(job) };
  }

  @RequirePermission('admin.export.manage')
  @Get(':id/download')
  async download(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const job = await this.svc.get(id);
    // A library can only download its own library's exports.
    if (job.scope !== 'tenant' || job.targetTenantId !== tenant.id) {
      throw new NotFoundException('Export not found.');
    }
    await streamExport(res, job);
  }
}
