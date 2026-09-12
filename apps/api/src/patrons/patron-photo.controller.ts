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
 * Patron photographs (2.0 phase 20b-ii).
 *
 *   POST   /t/:slug/patrons/:id/photo    (multipart `file`)
 *   DELETE /t/:slug/patrons/:id/photo
 *
 * Mirror of `bib-cover.controller.ts`, with three differences that matter.
 *
 * THE RESOURCE TYPE IS `members`, NOT `covers`. That is the storage layer's own
 * classification and it is a privacy boundary, not a folder name: a cover is a
 * public-facing image served through the download endpoint on every catalogue
 * page, and a patron photograph is PII. They have different MIME whitelists —
 * covers permit GIF and photos do not — and different handling downstream.
 *
 * `patron.photo.write`, its own permission key, which the volunteer template
 * does not carry. A photograph of a reader is the most identifying thing in the
 * record.
 *
 * AN ERASED PATRON CANNOT TAKE ONE. The Article 17 erase nulls
 * `photo_asset_ref` along with every other identifying field, and attaching a
 * new photograph to a tombstone would put a face back on a record somebody
 * asked to be forgotten.
 *
 * Everything else is the same and for the same reasons: upload before swapping
 * the reference so a failed upload leaves the old photo intact, and delete the
 * previous file best-effort so a storage failure leaks a file rather than
 * leaving the row pointing at one the caller believes was replaced.
 */
@Controller('t/:slug/patrons/:id/photo')
@UseGuards(TenantGuard, PermissionGuard)
export class PatronPhotoController {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
  ) {}

  @RequirePermission('patron.photo.write')
  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: loadEnv().storageMaxUploadBytes } }),
  )
  async upload(
    @TenantCtx() tenant: TenantContext,
    @Param('id') patronId: string,
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
    const patron = await client.patron.findUnique({
      where: { id: patronId },
      select: { id: true, photoAssetRef: true, erasedAt: true },
    });
    if (patron === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    if (patron.erasedAt !== null) {
      throw new BadRequestException(
        'This patron was erased under Article 17. Attaching a photograph would put a face back ' +
          'on a record somebody asked to be forgotten.',
      );
    }

    const stored = await this.storage.put(tenant, {
      resourceType: 'members',
      data: file.buffer,
      contentType: file.mimetype,
      ...(file.originalname === undefined ? {} : { originalName: file.originalname }),
    });

    const previousRef = patron.photoAssetRef;
    await client.patron.update({
      where: { id: patronId },
      data: { photoAssetRef: stored.ref, updatedAt: new Date() },
    });
    if (previousRef !== null && previousRef !== stored.ref) {
      await this.storage.delete(tenant, previousRef).catch(() => undefined);
    }
    return { patronId, photoAssetRef: stored.ref };
  }

  @RequirePermission('patron.photo.write')
  @Delete()
  async remove(@TenantCtx() tenant: TenantContext, @Param('id') patronId: string) {
    const client = this.tenantPrisma.getClientV2(tenant);
    const patron = await client.patron.findUnique({
      where: { id: patronId },
      select: { id: true, photoAssetRef: true },
    });
    if (patron === null) throw new NotFoundException(`No patron with id ${patronId}.`);
    if (patron.photoAssetRef !== null) {
      await this.storage.delete(tenant, patron.photoAssetRef).catch(() => undefined);
    }
    await client.patron.update({
      where: { id: patronId },
      data: { photoAssetRef: null, updatedAt: new Date() },
    });
    return { patronId, photoAssetRef: null };
  }
}
