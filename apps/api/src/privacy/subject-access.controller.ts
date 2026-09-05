import { Controller, Get, Inject, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { SubjectAccessService } from './subject-access.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * GET /t/:slug/members/:id/data-export — one member's whole record, as JSON.
 *
 * The Article 15 / Article 20 answer (privacy-legal-15). It sits beside the
 * Article 17 erase route on `MembersController` rather than beside the
 * whole-library dump in `ExportModule`, because it is the same act from the
 * librarian's side: a right exercised by one person, at the desk, about
 * themselves. The tenant export answers a different question (a library moving
 * its own database) and answering this one with that tool is what the finding
 * is about.
 *
 * Downloads directly rather than going through the export queue: this is one
 * member and a handful of indexed lookups, so there is no job to wait for — and
 * a queued export writes a file to disk that then has to be swept, which for a
 * routine subject-access request would leave a copy of somebody's record lying
 * around for hours. Nothing is persisted here; the bytes go to the browser.
 */
@Controller('t/:slug/members')
@UseGuards(TenantGuard, PermissionGuard)
export class SubjectAccessController {
  constructor(@Inject(SubjectAccessService) private readonly svc: SubjectAccessService) {}

  /**
   * `patron.pii.export` — not open to every role the way
   * `GET /members/:id` is.
   *
   * A `volunteer` may read the member page (that is what staffing a desk
   * needs), but assembling every field, the whole borrowing history, the
   * activity log and the member's photo into one portable file is a disclosure
   * decision, and the role exists precisely to keep destructive and
   * irreversible acts away from the person who helps out on Saturdays. Spelled
   * out rather than reusing `patron.read`: this is a read, and borrowing a
   * decorator whose docblock says "CREATE/EDIT/ARCHIVE" would make the next
   * person widening StaffWrite widen this by accident.
   */
  @RequirePermission('patron.pii.export')
  @Get(':id/data-export')
  async dataExport(
    @TenantCtx() tenant: TenantContext,
    @TenantActor() actor: TenantActor,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { filename, bundle } = await this.svc.build(tenant, id, actor);
    // `attachment` so a plain link on the member page saves the file instead of
    // painting a wall of a patron's data across a screen at the counter.
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Never cached: this is one person's complete record travelling over a
    // shared desk machine's browser.
    res.setHeader('Cache-Control', 'no-store');
    return bundle;
  }
}
