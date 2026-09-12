import {
  BadRequestException,
  Controller,
  Delete,
  Inject,
  NotFoundException,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { loadEnv } from '../config/env.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Cover images for a 2.0 catalogue record (phase 20b-ii).
 *
 *   POST   /t/:slug/catalog/bib/:id/cover    (multipart `file`)
 *   DELETE /t/:slug/catalog/bib/:id/cover
 *
 * ## Why it is a separate route rather than a field
 *
 * The same reason the 1.0 one is: JSON writes stay small, and a cataloguer can
 * save the record first and attach the cover later. It is also the only way to
 * send bytes without base64-inflating them by a third.
 *
 * ## `cover_asset_ref` is the one projected column the projector does not own
 *
 * `bib_records` is otherwise a pure projection of the MARC record, recomputed by
 * `projectBib` on every write. A cover is not in the MARC — it is a thing the
 * library attached — so `BibProjectionService` explicitly preserves this column
 * rather than overwriting it, and that is what makes writing it here safe. A
 * re-projection after a cover upload does not lose the cover.
 *
 * ## The ordering is the same as 1.0's, and for the same reason
 *
 * Upload the new image BEFORE swapping the reference. If the upload fails — a
 * quota, an unsupported type, a driver error — the old cover is still there and
 * still correct. Swapping first would leave a record pointing at nothing.
 *
 * The old file is then deleted BEST-EFFORT. A failure there leaks one file,
 * which `recomputeUsage` will eventually notice; a failure that propagated would
 * leave the record pointing at a file the caller believes was replaced.
 */
@Controller('t/:slug/catalog/bib/:id/cover')
@UseGuards(TenantGuard, PermissionGuard)
export class BibCoverController {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
  ) {}

  @RequirePermission('cat.cover.write')
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: loadEnv().storageMaxUploadBytes } }),
  )
  async upload(
    @TenantCtx() tenant: TenantContext,
    @Param('id') bibId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Attach an image under the "file" form field.');
    }
    const client = this.tenantPrisma.getClientV2(tenant);

    // The PROJECTION row, not `marc_records`: a record with no projection row
    // is one that has been deleted or never projected, and neither should take
    // a cover. That also makes the deleted check implicit — phase 20b-ii's
    // delete removes the projection row.
    const bib = await client.bibRecord.findUnique({
      where: { bibId },
      select: { bibId: true, coverAssetRef: true },
    });
    if (bib === null) {
      throw new NotFoundException(
        `No catalogue record ${bibId}, or it has been deleted. A deleted record cannot take a cover.`,
      );
    }

    const stored = await this.storage.put(tenant, {
      resourceType: 'covers',
      data: file.buffer,
      contentType: file.mimetype,
      ...(file.originalname === undefined ? {} : { originalName: file.originalname }),
    });

    const previousRef = bib.coverAssetRef;
    await client.bibRecord.update({
      where: { bibId },
      data: { coverAssetRef: stored.ref },
    });
    if (previousRef !== null && previousRef !== stored.ref) {
      await this.storage.delete(tenant, previousRef).catch(() => undefined);
    }
    return { bibId, coverAssetRef: stored.ref };
  }

  @RequirePermission('cat.cover.write')
  @Delete()
  async remove(@TenantCtx() tenant: TenantContext, @Param('id') bibId: string) {
    const client = this.tenantPrisma.getClientV2(tenant);
    const bib = await client.bibRecord.findUnique({
      where: { bibId },
      select: { bibId: true, coverAssetRef: true },
    });
    if (bib === null) throw new NotFoundException(`No catalogue record ${bibId}.`);
    if (bib.coverAssetRef !== null) {
      await this.storage.delete(tenant, bib.coverAssetRef).catch(() => undefined);
    }
    await client.bibRecord.update({ where: { bibId }, data: { coverAssetRef: null } });
    return { bibId, coverAssetRef: null };
  }
}
