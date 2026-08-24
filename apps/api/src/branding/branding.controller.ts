import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Inject,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { controlDb } from '@libriant/db-control';
import { checkBrandColor } from '@libriant/shared';
import { loadEnv } from '../config/env.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { StorageService } from '../storage/storage.service.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Per-library branding — accent colour + header logo. Admin-only. Stored on
 * the control-plane Tenant row (so it rides /auth/me into the shell); the logo
 * image lives in tenant storage and is served via /t/:slug/storage/<ref>.
 *
 *   PATCH  /t/:slug/branding        { brandColor }   — set/clear colour
 *   POST   /t/:slug/branding/logo   (multipart file) — upload logo
 *   DELETE /t/:slug/branding/logo                    — remove logo
 */
@Controller('t/:slug/branding')
@UseGuards(TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class BrandingController {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  @Patch()
  async setColor(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const body = (raw ?? {}) as { brandColor?: unknown };
    let color: string | null = null;
    let verdict: ReturnType<typeof checkBrandColor> = null;
    if (body.brandColor != null && body.brandColor !== '') {
      if (typeof body.brandColor !== 'string' || !HEX.test(body.brandColor)) {
        throw new BadRequestException('Brand colour must be a 6-digit hex value like #1f6feb.');
      }
      color = body.brandColor.toLowerCase();

      // frontend-16: any hex was accepted, and `--color-primary` is the
      // background of every primary button AND the colour of links and the
      // active nav item. A library could pick #f5f5f5 and make its own staff
      // unable to read the buttons they press all day — with no way to tell
      // that WE let them do it.
      //
      // Only the genuinely unusable case is REFUSED: neither foreground token
      // reaches AA on this colour, so no button label on it is legible. That is
      // a narrow bar on purpose — a bright brand colour (a yellow, say) is a
      // perfectly good button background, and refusing it would be us
      // overruling a library's identity rather than protecting its staff.
      //
      // Failing only as text is REPORTED, not refused, because the caller can
      // act on it: the response carries the readable foreground and both
      // ratios, so the settings screen can show "your links will be hard to
      // read" without us deciding the answer for them.
      verdict = checkBrandColor(color);
      if (verdict && !verdict.passesAsButton) {
        throw new BadRequestException(
          `That colour cannot carry readable button text (best contrast ${verdict.ratio.toFixed(2)}:1, ` +
            'WCAG AA needs 4.5:1). Pick a darker or lighter shade of it.',
        );
      }
    }
    await controlDb.tenant.update({ where: { id: tenant.id }, data: { brandColor: color } });
    // `contrast` is advisory. `foreground` is what the shell should set as
    // --color-primary-fg so the label on a primary button is the readable one
    // rather than always white.
    return { brandColor: color, contrast: verdict };
  }

  @Post('logo')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: loadEnv().storageMaxUploadBytes } }),
  )
  async uploadLogo(
    @TenantCtx() tenant: TenantContext,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (!file) throw new BadRequestException('Attach an image under the "file" form field.');
    const stored = await this.storage.put(tenant, {
      resourceType: 'branding',
      data: file.buffer,
      contentType: file.mimetype,
      originalName: file.originalname,
    });
    const current = await controlDb.tenant.findUnique({
      where: { id: tenant.id },
      select: { brandLogoRef: true },
    });
    await controlDb.tenant.update({
      where: { id: tenant.id },
      data: { brandLogoRef: stored.ref },
    });
    if (current?.brandLogoRef) {
      await this.storage.delete(tenant, current.brandLogoRef).catch(() => undefined);
    }
    return { brandLogoRef: stored.ref };
  }

  @Delete('logo')
  async removeLogo(@TenantCtx() tenant: TenantContext) {
    const current = await controlDb.tenant.findUnique({
      where: { id: tenant.id },
      select: { brandLogoRef: true },
    });
    if (current?.brandLogoRef) {
      await this.storage.delete(tenant, current.brandLogoRef).catch(() => undefined);
    }
    await controlDb.tenant.update({ where: { id: tenant.id }, data: { brandLogoRef: null } });
    return { brandLogoRef: null };
  }
}
