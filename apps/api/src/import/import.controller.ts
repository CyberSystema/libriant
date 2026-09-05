import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { RequiresFeature } from '../plans/decorators.js';
import { PlanGuard } from '../plans/plan.guard.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { assertBytesMatchContentType } from '../storage/content-sniff.js';
import { IMPORT_ENTITY_KINDS, mappableFields } from './mapping/entity-fields.js';
import { IMPORT_MAX_UPLOAD_BYTES } from './import.constants.js';
import { ImportService } from './import.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Bulk import / migration API. Gated by `bulk_import_enabled`; impersonating
 * Libriant support bypasses the plan gate (PlanGuard short-circuits).
 *
 *   GET    /t/:slug/imports                      — list batches
 *   GET    /t/:slug/imports/entities             — catalogue of importable entities + fields
 *   POST   /t/:slug/imports                      — upload (multipart `file` + fields) → preview + suggested mapping
 *   GET    /t/:slug/imports/:id                  — batch status + columns + mapping
 *   PATCH  /t/:slug/imports/:id/mapping          — set column mapping + duplicate mode
 *   POST   /t/:slug/imports/:id/validate         — enqueue a dry-run
 *   POST   /t/:slug/imports/:id/commit           — enqueue the commit
 *   GET    /t/:slug/imports/:id/issues           — paginated per-row problems
 *   GET    /t/:slug/imports/:id/errors.csv       — download the error rows
 *   POST   /t/:slug/imports/:id/cancel           — cancel a running/queued import
 *   DELETE /t/:slug/imports/:id                  — delete a finished/failed batch
 */
@Controller('t/:slug/imports')
@UseGuards(TenantGuard, PermissionGuard, PlanGuard)
@RequiresFeature('bulk_import_enabled')
export class ImportController {
  constructor(@Inject(ImportService) private readonly svc: ImportService) {}

  /** Static catalogue so the wizard can render entity choices + target fields. */
  @RequirePermission('admin.import.manage')
  @Get('entities')
  entities() {
    return {
      entities: IMPORT_ENTITY_KINDS.map((kind) => ({
        kind,
        fields: mappableFields(kind),
      })),
    };
  }

  @RequirePermission('admin.import.manage')
  @Get()
  list(@TenantCtx() tenant: TenantContext) {
    return this.svc.list(tenant);
  }

  @RequirePermission('admin.import.manage')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: IMPORT_MAX_UPLOAD_BYTES } }))
  async upload(
    @TenantCtx() tenant: TenantContext,
    @Req() req: Request,
    @Body() body: Record<string, string>,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Attach the file under the "file" form field.');
    }
    if (!body.entityKind) {
      throw new BadRequestException('Choose what to import via the "entityKind" field.');
    }
    // input-and-files-09: the other four upload routes get this inside
    // StorageService.put, but an import is staged straight to disk and never
    // touches that service — so the same check is applied here rather than
    // leaving one upload surface out. It only bites on declared types with an
    // unambiguous header (a .xlsx that is really HTML); CSV, TSV and MARC carry
    // no signature and are still detected from their bytes downstream.
    assertBytesMatchContentType(file.mimetype, file.buffer);
    return this.svc.createBatch(tenant, {
      entityKind: body.entityKind,
      file: { buffer: file.buffer, originalname: file.originalname, mimetype: file.mimetype },
      format: body.format || undefined,
      encoding: body.encoding || undefined,
      delimiter: body.delimiter || undefined,
      sheetName: body.sheetName || undefined,
      hasHeader: body.hasHeader === undefined ? undefined : body.hasHeader !== 'false',
      createdByUserId: req.session?.sub ?? null,
    });
  }

  @RequirePermission('admin.import.manage')
  @Get(':id')
  get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @RequirePermission('admin.import.manage')
  @Patch(':id/mapping')
  setMapping(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Body() body: { mapping?: unknown; duplicateMode?: unknown; options?: unknown },
  ) {
    return this.svc.setMapping(tenant, id, body);
  }

  @RequirePermission('admin.import.manage')
  @Post(':id/validate')
  validate(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.startValidate(tenant, id);
  }

  @RequirePermission('admin.import.manage')
  @Post(':id/commit')
  commit(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.startCommit(tenant, id);
  }

  @RequirePermission('admin.import.manage')
  @Get(':id/issues')
  issues(
    @TenantCtx() tenant: TenantContext,
    @Param('id') id: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('severity') severity?: string,
  ) {
    return this.svc.listIssues(tenant, id, {
      after: after && after.length ? after : undefined,
      limit: limit ? Number(limit) : undefined,
      severity: severity === 'error' || severity === 'warning' ? severity : undefined,
    });
  }

  @RequirePermission('admin.import.manage')
  @Get(':id/errors.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="import-errors.csv"')
  errorsCsv(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.errorsCsv(tenant, id);
  }

  @RequirePermission('admin.import.manage')
  @Post(':id/cancel')
  cancel(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.cancel(tenant, id);
  }

  @RequirePermission('admin.import.manage')
  @Delete(':id')
  remove(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.remove(tenant, id);
  }
}
