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
import { RolesGuard } from '../tenancy/roles.guard.js';
import { StaffWrite } from '../tenancy/roles.decorator.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { loadEnv } from '../config/env.js';

/**
 * Member photos. Mirror of how book covers work in `covers.controller.ts`:
 * upload-new → swap ref → delete-old. Refuses uploads to archived
 * members (the row still exists but the photo wouldn't be reachable from
 * any active listing).
 *
 *   POST   /t/:slug/members/:id/photo    (multipart `file`)
 *   DELETE /t/:slug/members/:id/photo
 */
// authn-authz-06: the class carried @UseGuards(TenantGuard) alone, so the
// read-only `volunteer` role could upload and delete. Proved by execution: a
// real volunteer account got 403 from POST /t/:slug/members (a @StaffWrite
// route) and 201 from this one.
//
// The guard is at CLASS level deliberately. Every handler here is a write —
// there are no reads to exempt — so a handler added later inherits the
// restriction instead of needing someone to remember it, which is how these
// three routes came to differ from the rest of the tenant surface in the first
// place.
@Controller('t/:slug/members/:id/photo')
@UseGuards(TenantGuard, RolesGuard)
@StaffWrite()
export class MemberPhotosController {
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
    @Param('id') memberId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) {
      throw new BadRequestException('Attach an image under the "file" form field.');
    }
    const client = this.tenantPrisma.getClient(tenant);
    const member = await client.member.findUnique({
      where: { id: memberId },
      select: { id: true, archivedAt: true, photoAssetRef: true },
    });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.archivedAt) {
      throw new BadRequestException("Can't attach a photo to an archived member.");
    }

    const stored = await this.storage.put(tenant, {
      resourceType: 'members',
      data: file.buffer,
      contentType: file.mimetype,
      originalName: file.originalname,
    });

    const previousRef = member.photoAssetRef;
    const updated = await client.member.update({
      where: { id: memberId },
      data: { photoAssetRef: stored.ref },
      select: { id: true, photoAssetRef: true },
    });
    if (previousRef && !previousRef.startsWith('photos/placeholder')) {
      await this.storage.delete(tenant, previousRef).catch(() => undefined);
    }
    return {
      memberId: updated.id,
      photoAssetRef: updated.photoAssetRef,
      sizeBytes: stored.sizeBytes,
      contentType: stored.contentType,
    };
  }

  @Delete()
  async remove(@TenantCtx() tenant: TenantContext, @Param('id') memberId: string) {
    const client = this.tenantPrisma.getClient(tenant);
    const member = await client.member.findUnique({
      where: { id: memberId },
      select: { id: true, photoAssetRef: true },
    });
    if (!member) throw new NotFoundException('Member not found.');
    if (member.photoAssetRef && !member.photoAssetRef.startsWith('photos/placeholder')) {
      await this.storage.delete(tenant, member.photoAssetRef).catch(() => undefined);
    }
    await client.member.update({
      where: { id: memberId },
      data: { photoAssetRef: null },
    });
    return { memberId, photoAssetRef: null };
  }
}
