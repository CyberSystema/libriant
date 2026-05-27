import { Body, Controller, Delete, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { validateDto } from '../auth/validate-dto.js';
import { CopiesService } from './copies.service.js';
import { CreateCopyDto, UpdateCopyDto } from './copies.dto.js';

/**
 * Copies live under the catalog. Create is nested under a book (you can't
 * have an orphan copy); update/archive operate by copy id since each
 * copy has a globally-unique id within the tenant.
 *
 *   POST   /t/:slug/catalog/books/:bookId/copies
 *   PATCH  /t/:slug/catalog/copies/:copyId
 *   DELETE /t/:slug/catalog/copies/:copyId            (archive)
 *
 * Loans/returns manipulate `status` themselves; this controller refuses
 * the `on_loan` ↔ other status transitions (see CopiesService).
 */
@Controller('t/:slug/catalog')
@UseGuards(TenantGuard)
export class CopiesController {
  constructor(@Inject(CopiesService) private readonly svc: CopiesService) {}

  @Post('books/:bookId/copies')
  async create(
    @TenantCtx() tenant: TenantContext,
    @Param('bookId') bookId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateCopyDto, raw);
    return this.svc.create(tenant, bookId, dto);
  }

  @Patch('copies/:copyId')
  async update(
    @TenantCtx() tenant: TenantContext,
    @Param('copyId') copyId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateCopyDto, raw);
    return this.svc.update(tenant, copyId, dto);
  }

  @Delete('copies/:copyId')
  async archive(@TenantCtx() tenant: TenantContext, @Param('copyId') copyId: string) {
    return this.svc.archive(tenant, copyId);
  }
}
