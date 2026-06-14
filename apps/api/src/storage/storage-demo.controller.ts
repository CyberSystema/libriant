import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { loadEnv } from '../config/env.js';
import { StorageService } from './storage.service.js';
import { SignedUrlService } from './signed-url.service.js';
import type { ResourceType } from './drivers/storage-driver.js';

const RESOURCE_TYPES: readonly ResourceType[] = [
  'covers',
  'members',
  'attachments',
  'marc',
  // Without this, signed downloads of per-library logos (commit d01f7f7) 400
  // and every header logo / branded asset renders broken.
  'branding',
];

/**
 * End-to-end exercise of the storage layer. The real catalog/members
 * controllers will use `StorageService` the same way; this controller
 * is a thin demo + the place where signed-URL downloads are mounted.
 *
 * Tenant-scoped endpoints (require session + matching tenant):
 *
 *   POST   /t/:slug/storage/:resourceType            (multipart 'file')
 *   GET    /t/:slug/storage/:resourceType/:filename
 *   DELETE /t/:slug/storage/:resourceType/:filename
 *   GET    /t/:slug/storage/:resourceType/:filename/signed-url
 *   POST   /t/:slug/storage/recompute                (rebuilds usage counter)
 *
 * Public endpoint (no session — the JWT IS the authorization):
 *
 *   GET    /_files/signed?token=<jwt>
 */
@Controller()
export class StorageDemoController {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(SignedUrlService) private readonly signedUrls: SignedUrlService,
    @Inject(TenantResolverService) private readonly resolver: TenantResolverService,
  ) {}

  // -------- Authenticated uploads / downloads ----------------------------

  @Post('t/:slug/storage/:resourceType')
  @UseGuards(TenantGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: loadEnv().storageMaxUploadBytes } }),
  )
  async upload(
    @TenantCtx() tenant: TenantContext,
    @Param('resourceType') resourceTypeRaw: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('Attach a file under the "file" form field.');
    const resourceType = this.parseResourceType(resourceTypeRaw);
    const stored = await this.storage.put(tenant, {
      resourceType,
      data: file.buffer,
      contentType: file.mimetype,
      originalName: file.originalname,
    });
    return {
      ...stored,
      // The UI uses these to render a download link without re-asking.
      tenantPathDownload: `/t/${tenant.slug}/storage/${stored.ref}`,
    };
  }

  @Get('t/:slug/storage/:resourceType/:filename')
  @UseGuards(TenantGuard)
  async download(
    @TenantCtx() tenant: TenantContext,
    @Param('resourceType') resourceTypeRaw: string,
    @Param('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    const resourceType = this.parseResourceType(resourceTypeRaw);
    const ref = `${resourceType}/${filename}`;
    const buf = await this.storage.get(tenant, ref);
    const stat = await this.storage.stat(tenant, ref);
    this.sendFile(res, buf, filename, stat.contentType);
  }

  @Delete('t/:slug/storage/:resourceType/:filename')
  @UseGuards(TenantGuard)
  async remove(
    @TenantCtx() tenant: TenantContext,
    @Param('resourceType') resourceTypeRaw: string,
    @Param('filename') filename: string,
  ) {
    const resourceType = this.parseResourceType(resourceTypeRaw);
    await this.storage.delete(tenant, `${resourceType}/${filename}`);
    return { ok: true };
  }

  @Get('t/:slug/storage/:resourceType/:filename/signed-url')
  @UseGuards(TenantGuard)
  async signedUrl(
    @TenantCtx() tenant: TenantContext,
    @Param('resourceType') resourceTypeRaw: string,
    @Param('filename') filename: string,
    @Query('ttlSec') ttlSecRaw?: string,
  ) {
    const resourceType = this.parseResourceType(resourceTypeRaw);
    const ref = `${resourceType}/${filename}`;
    // Stat first so we don't hand out URLs that 404 a second later.
    await this.storage.stat(tenant, ref);
    const ttlSec = ttlSecRaw ? Math.max(60, Math.min(86400, Number(ttlSecRaw))) : undefined;
    const { token, expiresAt } = this.signedUrls.sign({
      tenantId: tenant.id,
      ref,
      filename,
      ttlSec,
    });
    return {
      url: `/_files/signed?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  // Distinct path segment so it can't collide with `/storage/:resourceType`
  // (POST `/storage/recompute` would bind `recompute` as a resourceType and
  // multer would expect a file body).
  @Post('t/:slug/storage-admin/recompute')
  @UseGuards(TenantGuard)
  async recompute(@TenantCtx() tenant: TenantContext) {
    const total = await this.storage.recomputeUsage(tenant);
    return { storageUsedBytes: total.toString() };
  }

  // -------- Public, token-authorized -------------------------------------

  @Get('_files/signed')
  async downloadSigned(@Query('token') token: string | undefined, @Res() res: Response) {
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Missing token.');
    }
    const payload = this.signedUrls.verify(token);
    if (!payload) throw new NotFoundException('Link expired or invalid.');

    // The token carries the tenantId — resolve it back to a full context
    // so we can pick the right driver. No middleware ran for this URL.
    const tenant = await this.resolveTenantById(payload.tid);
    if (!tenant) throw new NotFoundException('Link expired or invalid.');

    const buf = await this.storage.get(tenant, payload.ref);
    const stat = await this.storage.stat(tenant, payload.ref);
    const filename = payload.fn ?? payload.ref.split('/').pop()!;
    this.sendFile(res, buf, filename, stat.contentType);
  }

  // -------- internals ----------------------------------------------------

  private parseResourceType(raw: string): ResourceType {
    if ((RESOURCE_TYPES as readonly string[]).includes(raw)) return raw as ResourceType;
    throw new BadRequestException(
      `Unknown resource type "${raw}". Use one of: ${RESOURCE_TYPES.join(', ')}.`,
    );
  }

  /** Resolve a tenant id back to a TenantContext via the resolver cache. */
  private async resolveTenantById(tenantId: string): Promise<TenantContext | null> {
    // The resolver indexes by slug, not by id — but we don't have a slug
    // in the token. Read the bare row from control DB; for the storage
    // path that's enough.
    const { controlDb } = await import('@libriant/db-control');
    const row = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        slug: true,
        name: true,
        defaultLocale: true,
        status: true,
        dbUrl: true,
        storageUrl: true,
        customSubdomain: true,
        tags: true,
      },
    });
    if (!row || row.status !== 'active') return null;
    // `resolvedFrom` is irrelevant here — the URL didn't include a tenant.
    return { ...row, resolvedFrom: 'subdomain' as const };
  }

  private sendFile(
    res: Response,
    body: Buffer,
    filename: string,
    contentType: string | undefined,
  ): void {
    res.set({
      'content-type': contentType ?? 'application/octet-stream',
      // attachment + nosniff together neutralise "HTML uploaded as JPEG"
      // class of attack — browsers won't render the body as HTML even if
      // the content-type is wrong.
      'content-disposition': `attachment; filename="${sanitiseFilename(filename)}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=0, no-store',
    });
    res.send(body);
  }
}

/** Strip path-ish characters from a filename used in a Content-Disposition. */
function sanitiseFilename(name: string): string {
  return name.replace(/[\\/\0]/g, '_').slice(0, 200);
}
