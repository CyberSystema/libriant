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
import { QuotaInterceptor } from '../plans/quota.interceptor.js';
import { validateDto } from '../auth/validate-dto.js';
import { parseIntParam, parseLimit } from '../platform/query.js';
import { BooksService } from './books.service.js';
import { CreateBookDto, UpdateBookDto } from './books.dto.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { StaffWrite } from '../tenancy/roles.decorator.js';

/**
 *   GET    /t/:slug/catalog/books?q=&authorId=&yearFrom=&yearTo=&after=&limit=
 *   POST   /t/:slug/catalog/books     [quota: max_books — enforced in the service]
 *   GET    /t/:slug/catalog/books/:id
 *   PATCH  /t/:slug/catalog/books/:id
 *   DELETE /t/:slug/catalog/books/:id              (archive)
 *
 * `customFields` on create/update is validated against the tenant's
 * active `FieldDefinition` rows for `entity_kind='book'`.
 */
@Controller('t/:slug/catalog/books')
@UseGuards(TenantGuard, RolesGuard)
// Mounted at class level even though no route here carries `@RequiresQuota`
// today (see `create` for why `max_books` is enforced in the service instead).
// With no metadata the interceptor is one reflector lookup and a pass-through;
// the alternative failure — someone adds `@RequiresQuota` to a route on an
// unmounted interceptor and the quota silently never applies — is worse.
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
      yearFrom: parseIntParam(yearFrom),
      yearTo: parseIntParam(yearTo),
      after: after && after.length ? after : undefined,
      limit: parseLimit(limit),
      includeArchived: includeArchived === '1' || includeArchived === 'true',
    });
  }

  /**
   * NO `@RequiresQuota('max_books')` HERE, DELIBERATELY — performance-05.
   *
   * `max_books` on this route has a stronger enforcer than the interceptor:
   * `BooksService.create` runs the count and the insert inside ONE transaction
   * behind `pg_advisory_xact_lock('quota:<tenant>:max_books:')`, so parallel
   * creates cannot each pass a check and land the library past its ceiling.
   * The interceptor's pre-check is the racy version of that same check — its
   * own docblock says so — and it is not free: `QUOTA_COUNTERS.max_books` is
   * `book.count({ where: { archivedAt: null } })`, which nothing indexes, so
   * with the decorator here a book create ran that full catalogue scan TWICE.
   * Measured on the audit's 400,000-title fixture: `Seq Scan on books,
   * Buffers: shared read=13333, Execution Time: 67.7 ms` per scan. Driven
   * through the real route with subscriptions ON, a create went from two of
   * those statements to one.
   *
   * Enforcement is unchanged, not relaxed — `apps/api/test/integration/
   * performance-hot-paths.spec.ts` arms subscriptions, pins this tenant to a
   * finite `max_books` and asserts this route still answers 402 at the ceiling.
   * `update` (un-archiving consumes a seat) has always been transactional-only
   * for the same reason; this makes create match it.
   */
  @StaffWrite()
  @Post()
  async create(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(CreateBookDto, raw);
    return this.svc.create(tenant, dto);
  }

  @Get(':id')
  async get(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.get(tenant, id);
  }

  @StaffWrite()
  @Patch(':id')
  async update(@TenantCtx() tenant: TenantContext, @Param('id') id: string, @Body() raw: unknown) {
    const dto = await validateDto(UpdateBookDto, raw);
    return this.svc.update(tenant, id, dto);
  }

  @StaffWrite()
  @Delete(':id')
  async archive(@TenantCtx() tenant: TenantContext, @Param('id') id: string) {
    return this.svc.archive(tenant, id);
  }
}
