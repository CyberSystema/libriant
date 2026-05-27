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

/**
 * Book covers are uploaded to the per-tenant storage and the resulting
 * ref is stored on the book row. Keeping this on a dedicated endpoint
 * means JSON catalog updates stay small and clients can upload covers
 * incrementally (e.g. "save the book first, attach the cover later").
 *
 *   POST   /t/:slug/catalog/books/:id/cover    (multipart `file`)
 *   DELETE /t/:slug/catalog/books/:id/cover
 */
@Controller('t/:slug/catalog/books/:id/cover')
@UseGuards(TenantGuard)
export class CoversController {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
  ) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: loadEnv().storageMaxUploadBytes } }),
  )
  async upload(
    @TenantCtx() tenant: TenantContext,
    @Param('id') bookId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Attach an image under the "file" form field.');
    }
    const client = this.tenantPrisma.getClient(tenant);
    const book = await client.book.findUnique({
      where: { id: bookId },
      select: { id: true, archivedAt: true, coverAssetRef: true },
    });
    if (!book) throw new NotFoundException('Book not found.');
    if (book.archivedAt) {
      throw new BadRequestException("Can't attach a cover to an archived book.");
    }

    // Upload the new cover BEFORE replacing the old ref. If the new
    // upload fails (e.g. quota), the old cover stays intact.
    const stored = await this.storage.put(tenant, {
      resourceType: 'covers',
      data: file.buffer,
      contentType: file.mimetype,
      originalName: file.originalname,
    });

    // Swap the ref. Best-effort delete of the previous file so we don't
    // leak storage.
    const previousRef = book.coverAssetRef;
    const updated = await client.book.update({
      where: { id: bookId },
      data: { coverAssetRef: stored.ref },
      select: { id: true, coverAssetRef: true },
    });
    if (previousRef && !previousRef.startsWith('covers/placeholder')) {
      await this.storage.delete(tenant, previousRef).catch(() => undefined);
    }
    return {
      bookId: updated.id,
      coverAssetRef: updated.coverAssetRef,
      sizeBytes: stored.sizeBytes,
      contentType: stored.contentType,
    };
  }

  @Delete()
  async remove(@TenantCtx() tenant: TenantContext, @Param('id') bookId: string) {
    const client = this.tenantPrisma.getClient(tenant);
    const book = await client.book.findUnique({
      where: { id: bookId },
      select: { id: true, coverAssetRef: true },
    });
    if (!book) throw new NotFoundException('Book not found.');
    if (book.coverAssetRef && !book.coverAssetRef.startsWith('covers/placeholder')) {
      await this.storage.delete(tenant, book.coverAssetRef).catch(() => undefined);
    }
    await client.book.update({
      where: { id: bookId },
      data: { coverAssetRef: null },
    });
    return { bookId, coverAssetRef: null };
  }
}
