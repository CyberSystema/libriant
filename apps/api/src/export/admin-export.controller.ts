import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { clientIp } from '../platform/client-ip.js';
import { validateDto } from '../auth/validate-dto.js';
import { ExportService, publicExportJob } from './export.service.js';
import { CreateAdminExportDto } from './export.dto.js';
import { streamExport } from './export-download.js';
import { recordAdminExportDownload, type ExportRequester } from './export-consent.js';

/**
 * Owner-admin database export — a library, the control DB, or everything.
 *
 *   GET  /admin/exports               — recent exports
 *   GET  /admin/exports/tenants       — id/slug/name list for the picker
 *   POST /admin/exports               — start ({ format, scope, tenantId? })
 *   GET  /admin/exports/:id/download  — download the produced file
 *
 * `scope: 'tenant'` additionally requires an active, tenant-issued support
 * session for that library, and every start + download is written to the
 * control-plane audit log (and, for a tenant export, to the library's own).
 * See export-consent.ts for why (privacy-legal-07).
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
  async create(@Req() req: Request, @AdminSess() admin: AdminSessionPayload, @Body() raw: unknown) {
    const dto = await validateDto(CreateAdminExportDto, raw);
    const job = await this.svc.createForAdmin(requesterFrom(req, admin), {
      format: dto.format,
      scope: dto.scope,
      tenantId: dto.tenantId,
    });
    return { export: publicExportJob(job) };
  }

  @Get(':id/download')
  @AdminRoles('owner')
  async download(
    @Req() req: Request,
    @AdminSess() admin: AdminSessionPayload,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const job = await this.svc.get(id);
    // Awaited before a byte leaves: the artifact outlives the support session
    // that authorised it (24 h tenant / 2 h control), so "who fetched the file,
    // and when" is a separate fact from "who started the export".
    await recordAdminExportDownload(job, requesterFrom(req, admin));
    await streamExport(res, job);
  }
}

/** Who is asking, and from where — the attribution the audit rows carry. */
function requesterFrom(req: Request, admin: AdminSessionPayload): ExportRequester {
  const ua = req.headers['user-agent'];
  return {
    adminId: admin.sub,
    ip: clientIp(req),
    userAgent: (Array.isArray(ua) ? ua[0] : ua) || undefined,
  };
}
