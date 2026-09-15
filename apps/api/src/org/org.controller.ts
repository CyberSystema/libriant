import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { OrgService } from './org.service.js';
import { BranchListQueryDto, LocationListQueryDto } from './org.dto.js';

/**
 * The library's own shape: branches and shelving locations (2.0 phase 20a).
 *
 *   GET /t/:slug/org/branches   — the buildings
 *   GET /t/:slug/org/locations  — the shelves, optionally within one branch
 *
 * ## Why `cat.bib.read` and not a new key
 *
 * These answer "what places does this library have", which every staff screen
 * with a branch filter needs and which no screen can function without. A
 * dedicated `org.read` key would have to be added to all four role templates to
 * mean "yes, obviously" — and `permissions.test.ts` asserts owner's key count
 * equals `PERMISSION_KEYS.length` and that volunteer ⊂ librarian ⊂ admin ⊂ owner
 * strictly, so adding one is four edits for a distinction nobody has asked for.
 * Anyone who may read the catalogue may know where the library keeps it.
 *
 * The EDITING of branches is a different matter and is not here. This controller
 * is read-only on purpose: creating a branch changes circulation policy
 * resolution, item ownership and calendar inheritance all at once, and belongs
 * with the phase that owns those rules rather than beside a dropdown feed.
 */
@Controller('t/:slug/org')
@UseGuards(TenantGuard, PermissionGuard)
export class OrgController {
  constructor(@Inject(OrgService) private readonly org: OrgService) {}

  @RequirePermission('cat.bib.read')
  @Get('branches')
  async branches(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(BranchListQueryDto, rawQuery ?? {});
    return this.org.branches(tenant, { includeArchived: q.includeArchived !== undefined });
  }

  /**
   * `cat.bib.read`, like its two neighbours. A cataloguer who may list the
   * library's branches may list the kinds of thing it lends, and inventing a
   * key for it would mean editing all four role templates for a distinction
   * nobody has asked for.
   */
  @RequirePermission('cat.bib.read')
  @Get('item-types')
  async itemTypes(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(BranchListQueryDto, rawQuery ?? {});
    return this.org.itemTypes(tenant, { includeArchived: q.includeArchived !== undefined });
  }

  @RequirePermission('cat.bib.read')
  @Get('locations')
  async locations(@TenantCtx() tenant: TenantContext, @Query() rawQuery: unknown) {
    const q = await validateDto(LocationListQueryDto, rawQuery ?? {});
    return this.org.locations(tenant, {
      branchId: q.branchId,
      includeArchived: q.includeArchived !== undefined,
    });
  }
}
