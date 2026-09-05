import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Sess } from '../auth/session-context.js';
import type { SessionPayload } from '../auth/jwt-session.service.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { parseLimit } from '../platform/query.js';
import { CollectionRecordsService, type ListRecordsOptions } from './collection-records.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Generic CRUD for records of a custom collection. Validation is driven
 * by that collection's field definitions at the moment of the request
 * (so an admin enabling a new required field instantly affects writes
 * but leaves existing records untouched — read it back, patch it, the
 * required field becomes mandatory on the patch).
 *
 *   GET    /t/:slug/collections/:cslug/records
 *   POST   /t/:slug/collections/:cslug/records
 *   GET    /t/:slug/collections/:cslug/records/:id
 *   PATCH  /t/:slug/collections/:cslug/records/:id
 *   DELETE /t/:slug/collections/:cslug/records/:id              (archive)
 */
@Controller('t/:slug/collections/:cslug/records')
@UseGuards(TenantGuard, PermissionGuard)
export class CollectionRecordsController {
  constructor(@Inject(CollectionRecordsService) private readonly svc: CollectionRecordsService) {}

  @RequirePermission('data.record.read')
  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    const opts: ListRecordsOptions = {
      after: after && after.length ? after : undefined,
      limit: parseLimit(limit),
      q: q && q.length ? q : undefined,
      includeArchived: includeArchived === '1' || includeArchived === 'true',
    };
    return this.svc.list(tenant, cslug, opts);
  }

  @RequirePermission('data.record.write')
  @Post()
  async create(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Body() raw: unknown,
    @Sess() session: SessionPayload,
  ) {
    return this.svc.create(tenant, cslug, raw, session.sub);
  }

  @RequirePermission('data.record.read')
  @Get(':id')
  async get(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Param('id') id: string,
  ) {
    return this.svc.get(tenant, cslug, id);
  }

  @RequirePermission('data.record.write')
  @Patch(':id')
  async update(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    return this.svc.update(tenant, cslug, id, raw);
  }

  @RequirePermission('data.record.delete')
  @Delete(':id')
  async archive(
    @TenantCtx() tenant: TenantContext,
    @Param('cslug') cslug: string,
    @Param('id') id: string,
  ) {
    return this.svc.archive(tenant, cslug, id);
  }
}
