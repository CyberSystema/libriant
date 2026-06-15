import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { validateDto } from '../auth/validate-dto.js';
import { ExportService, publicExportJob } from './export.service.js';
import { CreateAdminExportDto } from './export.dto.js';
import { streamExport } from './export-download.js';

/**
 * Owner-admin database export — a library, the control DB, or everything.
 *
 *   GET  /admin/exports               — recent exports
 *   GET  /admin/exports/tenants       — id/slug/name list for the picker
 *   POST /admin/exports               — start ({ format, scope, tenantId? })
 *   GET  /admin/exports/:id/download  — download the produced file
 */
@Controller('admin/exports')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminExportController {
  constructor(@Inject(ExportService) private readonly svc: ExportService) {}

  @Get()
  async list() {
    return { exports: (await this.svc.listForAdmin()).map(publicExportJob) };
  }

  @Get('tenants')
  async tenants() {
    const tenants = await controlDb.tenant.findMany({
      where: { archivedAt: null },
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, name: true },
    });
    return { tenants };
  }

  @Post()
  @AdminRoles('owner')
  @HttpCode(202)
  async create(@AdminSess() admin: AdminSessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(CreateAdminExportDto, raw);
    const job = await this.svc.createForAdmin(admin.sub, {
      format: dto.format,
      scope: dto.scope,
      tenantId: dto.tenantId,
    });
    return { export: publicExportJob(job) };
  }

  @Get(':id/download')
  @AdminRoles('owner')
  async download(@Param('id') id: string, @Res() res: Response) {
    const job = await this.svc.get(id);
    await streamExport(res, job);
  }
}
