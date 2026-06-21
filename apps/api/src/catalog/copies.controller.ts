import {
  BadRequestException,
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
import { CopiesService } from './copies.service.js';
import { CreateCopyDto, UpdateCopyDto } from './copies.dto.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { StaffWrite } from '../tenancy/roles.decorator.js';

/** Bound the barcode query so a hostile caller can't probe with huge strings. */
const MAX_BARCODE_LEN = 128;

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
@UseGuards(TenantGuard, RolesGuard)
export class CopiesController {
  constructor(@Inject(CopiesService) private readonly svc: CopiesService) {}

  /**
   * Resolve a scanned copy barcode → its copy + book. Drives scan-to-checkout
   * and scan-to-return. Declared before the `copies/:copyId` routes so the
   * literal `lookup` segment isn't swallowed by the param.
   */
  @Get('copies/lookup')
  async lookupByBarcode(@TenantCtx() tenant: TenantContext, @Query('barcode') barcode?: string) {
    const value = (barcode ?? '').trim();
    if (!value) throw new BadRequestException('A barcode is required.');
    if (value.length > MAX_BARCODE_LEN) {
      throw new BadRequestException(`A barcode is at most ${MAX_BARCODE_LEN} characters.`);
    }
    return this.svc.lookupByBarcode(tenant, value);
  }

  @StaffWrite()
  @Post('books/:bookId/copies')
  async create(
    @TenantCtx() tenant: TenantContext,
    @Param('bookId') bookId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(CreateCopyDto, raw);
    return this.svc.create(tenant, bookId, dto);
  }

  @StaffWrite()
  @Patch('copies/:copyId')
  async update(
    @TenantCtx() tenant: TenantContext,
    @Param('copyId') copyId: string,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(UpdateCopyDto, raw);
    return this.svc.update(tenant, copyId, dto);
  }

  @StaffWrite()
  @Delete('copies/:copyId')
  async archive(@TenantCtx() tenant: TenantContext, @Param('copyId') copyId: string) {
    return this.svc.archive(tenant, copyId);
  }
}
