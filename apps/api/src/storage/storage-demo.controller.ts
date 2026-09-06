import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { controlDb } from '@libriant/db-control';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { PermissionGuard } from '../authz/permission.guard.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { loadEnv } from '../config/env.js';
import { StorageService } from './storage.service.js';
import { SignedUrlService } from './signed-url.service.js';
import type { ResourceType } from './drivers/storage-driver.js';
import { TENANT_CONTEXT_SELECT, tenantContextFrom } from '../tenancy/tenant-db-url.js';

const RESOURCE_TYPES: readonly ResourceType[] = [
  'covers',
  'members',
  'attachments',
  'marc',
  // Without this, signed downloads of per-library logos (commit d01f7f7) 400
  // and every header logo / branded asset renders broken.
  'branding',
];

// TEN-06 / storage-new: resource types whose contents are sensitive enough
// that the least-privileged role (volunteer) shouldn't be able to read them
// or hand out day-long signed bearer links to them. `members` are PII photos
// and `attachments` are arbitrary member/loan documents. `covers`, `marc` and
// `branding` are display/catalog assets surfaced to every signed-in user (the
// app header logo and book covers load through the download endpoint on every
// page), so a blanket role floor there would break the UI for volunteers.
const RESTRICTED_RESOURCE_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'members',
  'attachments',
]);

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

  // authn-authz-06: this was @UseGuards(TenantGuard, PermissionGuard) alone while the DELETE
  // below already had RolesGuard — so the read-only `volunteer` role could
  // upload but not remove. Per-handler rather than class-level here, unlike the
  // photo and cover controllers, because this class also serves genuine reads
  // (signed downloads) that every staff role is entitled to.
  @RequirePermission('cat.cover.write')
  @Post('t/:slug/storage/:resourceType')
  @UseGuards(TenantGuard, PermissionGuard)
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

  @RequirePermission('cat.bib.read')
  @Get('t/:slug/storage/:resourceType/:filename')
  @UseGuards(TenantGuard, PermissionGuard)
  async download(
    @TenantCtx() tenant: TenantContext,
    @Param('resourceType') resourceTypeRaw: string,
    @Param('filename') filename: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const resourceType = this.parseResourceType(resourceTypeRaw);
    // TEN-06: floor reads of sensitive resource types at librarian. Display
    // assets (covers/branding/marc) stay open to all members so the header
    // logo and catalog covers keep rendering for volunteers.
    await this.assertMayAccess(req, resourceType);
    const ref = `${resourceType}/${filename}`;
    const buf = await this.storage.get(tenant, ref);
    const stat = await this.storage.stat(tenant, ref);
    this.sendFile(res, buf, filename, stat.contentType);
  }

  @RequirePermission('cat.file.delete')
  @Delete('t/:slug/storage/:resourceType/:filename')
  @UseGuards(TenantGuard, PermissionGuard)
  async remove(
    @TenantCtx() tenant: TenantContext,
    @Param('resourceType') resourceTypeRaw: string,
    @Param('filename') filename: string,
  ) {
    const resourceType = this.parseResourceType(resourceTypeRaw);
    await this.storage.delete(tenant, `${resourceType}/${filename}`);
    return { ok: true };
  }

  @RequirePermission('cat.bib.read')
  @Get('t/:slug/storage/:resourceType/:filename/signed-url')
  @UseGuards(TenantGuard, PermissionGuard)
  async signedUrl(
    @TenantCtx() tenant: TenantContext,
    @Param('resourceType') resourceTypeRaw: string,
    @Param('filename') filename: string,
    @Req() req: Request,
    @Query('ttlSec') ttlSecRaw?: string,
  ) {
    const resourceType = this.parseResourceType(resourceTypeRaw);
    // storage-new / TEN-06: minting a publicly-shareable signed URL (a bearer
    // link that bypasses the app's auth boundary for up to 24h) is a strictly
    // stronger capability than an in-app download, so it carries the same
    // sensitive-resource role floor as `download`.
    await this.assertMayAccess(req, resourceType);
    const ref = `${resourceType}/${filename}`;
    // Stat first so we don't hand out URLs that 404 a second later.
    await this.storage.stat(tenant, ref);
    // STG-04: validate ttlSec. A non-numeric param used to reach jwt.sign as
    // `expiresIn: NaN`, throwing an uncaught 500. Reject malformed input with a
    // 400 instead; an absent param falls back to the configured default TTL.
    // Sensitive resource types also get a shorter TTL cap so leaked PII links
    // expire sooner.
    const ttlSec = this.parseTtlSec(ttlSecRaw, resourceType);
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
  @RequirePermission('admin.settings.edit')
  @Post('t/:slug/storage-admin/recompute')
  @UseGuards(TenantGuard, PermissionGuard)
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

  /**
   * Parse + clamp the optional `ttlSec` query param. Returns `undefined` when
   * absent (so the signer uses its default TTL), clamps a valid number into
   * [60, maxTtl], and rejects non-numeric input with a 400 rather than letting
   * `NaN` propagate into `jwt.sign({ expiresIn })` as an uncaught 500 (STG-04).
   * Sensitive resource types (member PII) get a tighter 1h cap so a leaked link
   * has a shorter blast window (TEN-06).
   */
  private parseTtlSec(raw: string | undefined, resourceType: ResourceType): number | undefined {
    const maxTtl = RESTRICTED_RESOURCE_TYPES.has(resourceType) ? 3600 : 86400;
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new BadRequestException('ttlSec must be a number of seconds.');
    }
    return Math.max(60, Math.min(maxTtl, n));
  }

  /**
   * TEN-06: floor read / signed-url access to sensitive resource types
   * (members, attachments) at `librarian`. Mirrors `RolesGuard`: reads the
   * user's CURRENT role from the control DB (not the JWT, which can be stale)
   * and lets an impersonating Libriant admin through. Open resource types
   * (covers/marc/branding) skip the check entirely so the UI keeps working for
   * volunteers. Runs after `TenantGuard`, so the caller is a proven member.
   */
  private async assertMayAccess(req: Request, resourceType: ResourceType): Promise<void> {
    if (!RESTRICTED_RESOURCE_TYPES.has(resourceType)) return;
    if (req.impersonation) return;
    if (!req.session) {
      throw new ForbiddenException('This file is restricted to library staff.');
    }
    const user = await controlDb.user.findUnique({
      where: { id: req.session.sub },
      select: { role: true },
    });
    if (!user || user.role === 'volunteer') {
      throw new ForbiddenException('This file is restricted to library staff.');
    }
  }

  /** Resolve a tenant id back to a TenantContext via the resolver cache. */
  private async resolveTenantById(tenantId: string): Promise<TenantContext | null> {
    // The resolver indexes by slug, not by id — but we don't have a slug
    // in the token. Read the bare row from control DB; for the storage
    // path that's enough.
    const { controlDb } = await import('@libriant/db-control');
    const row = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: TENANT_CONTEXT_SELECT,
    });
    if (!row || row.status !== 'active') return null;
    // `resolvedFrom` is irrelevant here — the URL didn't include a tenant.
    return tenantContextFrom(row, 'subdomain');
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
      'content-disposition': contentDisposition(filename),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=0, no-store',
    });
    res.send(body);
  }
}

/**
 * Build a Content-Disposition header value for a download. STG-06: an ASCII
 * `filename=` token must never contain CR/LF/`"`/control chars (header
 * injection / quote-breakout) — `asciiFilename` collapses those to `_`. We
 * also emit an RFC 5987 `filename*=UTF-8''<percent-encoded>` so non-ASCII
 * names (e.g. Greek titles) survive intact in modern browsers; the ASCII
 * `filename=` is the legacy fallback.
 */
function contentDisposition(name: string): string {
  const ascii = asciiFilename(name);
  const encoded = encodeRfc5987(name);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Reduce a filename to a safe quoted-string token: strip path separators,
 * NUL, the double-quote that would break out of the quoted value, and any
 * CR/LF or other control characters that could inject a new header.
 */
function asciiFilename(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex -- intentional: strip control chars
      .replace(/[\\/\0"\r\n\x00-\x1f\x7f]/g, '_')
      .slice(0, 200) || 'download'
  );
}

/** Percent-encode a UTF-8 filename per RFC 5987's `ext-value` grammar. */
function encodeRfc5987(name: string): string {
  return (
    encodeURIComponent(name.slice(0, 200))
      // encodeURIComponent leaves these unescaped, but RFC 5987 disallows them
      // in an attr-char run, so escape them explicitly.
      .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  );
}
