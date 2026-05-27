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
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { validateDto } from '../auth/validate-dto.js';
import { AuthorsService } from './authors.service.js';
import { CreateAuthorDto, UpdateAuthorDto } from './authors.dto.js';

/**
 *   GET    /t/:slug/catalog/authors?q=&after=&limit=&includeArchived=
 *   POST   /t/:slug/catalog/authors
 *   GET    /t/:slug/catalog/authors/:id
 *   PATCH  /t/:slug/catalog/authors/:id
 *   DELETE /t/:slug/catalog/authors/:id              (archive)
 */
@Controller('t/:slug/catalog/authors')
@UseGuards(TenantGuard)
export class AuthorsController {
  constructor(@Inject(AuthorsService) private readonly svc: AuthorsService) {}

  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Query('q') q?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.svc.list(tenant, {
      q: q && q.length ? q : undefined,
      after: after && after.length ? after : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      includeArchived: includeArchived === '1' || includeArchived === 'true',
    });
  }

  @Post()
  async create(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(CreateAuthorDto, raw);
    return this.svc.create(tenant, dto);
  }

  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @Patch(':id')
  async update(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdateAuthorDto, raw);
    return this.svc.update(tenant, id, dto);
  }

  @Delete(':id')
  async archive(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.archive(tenant, id);
  }
}
