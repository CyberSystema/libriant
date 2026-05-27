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
  UseInterceptors,
} from '@nestjs/common';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RequiresQuota } from '../plans/decorators.js';
import { QuotaInterceptor } from '../plans/quota.interceptor.js';
import { validateDto } from '../auth/validate-dto.js';
import { BooksService } from './books.service.js';
import { CreateBookDto, UpdateBookDto } from './books.dto.js';

/**
 *   GET    /t/:slug/catalog/books?q=&authorId=&yearFrom=&yearTo=&after=&limit=
 *   POST   /t/:slug/catalog/books     [quota: max_books]
 *   GET    /t/:slug/catalog/books/:id
 *   PATCH  /t/:slug/catalog/books/:id
 *   DELETE /t/:slug/catalog/books/:id              (archive)
 *
 * `customFields` on create/update is validated against the tenant's
 * active `FieldDefinition` rows for `entity_kind='book'`.
 */
@Controller('t/:slug/catalog/books')
@UseGuards(TenantGuard)
@UseInterceptors(QuotaInterceptor)
export class BooksController {
  constructor(@Inject(BooksService) private readonly svc: BooksService) {}

  @Get()
  async list(
    @TenantCtx() tenant: TenantContext,
    @Query('q') q?: string,
    @Query('authorId') authorId?: string,
    @Query('yearFrom') yearFrom?: string,
    @Query('yearTo') yearTo?: string,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.svc.list(tenant, {
      q: q && q.length ? q : undefined,
      authorId: authorId && authorId.length ? authorId : undefined,
      yearFrom: yearFrom ? Number.parseInt(yearFrom, 10) : undefined,
      yearTo: yearTo ? Number.parseInt(yearTo, 10) : undefined,
      after: after && after.length ? after : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      includeArchived: includeArchived === '1' || includeArchived === 'true',
    });
  }

  @Post()
  @RequiresQuota('max_books')
  async create(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(CreateBookDto, raw);
    return this.svc.create(tenant, dto);
  }

  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @Patch(':id')
  async update(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdateBookDto, raw);
    return this.svc.update(tenant, id, dto);
  }

  @Delete(':id')
  async archive(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.archive(tenant, id);
  }
}
