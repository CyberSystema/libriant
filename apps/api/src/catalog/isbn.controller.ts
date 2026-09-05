import { Controller, Get, Inject, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { PlanGuard } from '../plans/plan.guard.js';
import { RequiresFeature } from '../plans/decorators.js';
import { IsbnLookupService } from './isbn.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * GET /t/:slug/catalog/isbn-lookup/:isbn
 *
 * Pre-fill helper for the new-book form. Gated on the
 * `isbn_lookup_enabled` plan feature. Returns 404 for ISBNs OpenLibrary
 * doesn't recognise — friendlier than 200 with empty fields.
 */
@Controller('t/:slug/catalog/isbn-lookup')
@UseGuards(TenantGuard, PermissionGuard, PlanGuard)
export class IsbnController {
  constructor(@Inject(IsbnLookupService) private readonly svc: IsbnLookupService) {}

  @RequirePermission('cat.isbn.lookup')
  @Get(':isbn')
  @RequiresFeature('isbn_lookup_enabled')
  async lookup(@Param('isbn') isbn: string) {
    const result = await this.svc.lookup(isbn);
    if (!result) {
      throw new NotFoundException(
        "We couldn't find this ISBN. You can still add the book by filling in the details by hand.",
      );
    }
    return result;
  }
}
