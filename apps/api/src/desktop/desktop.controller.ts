import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { DesktopReleaseService, type DesktopPlatform } from './desktop-release.service.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Library-facing desktop-app endpoints.
 *
 *   GET /t/:slug/desktop/access    — entitlement only (cheap; no GitHub call)
 *   GET /t/:slug/desktop/release   — entitlement + the latest available installers
 *   GET /t/:slug/desktop/download?platform=mac|win|linux — gated installer stream
 *
 * Reads are open to all staff (the panel + the shell's runtime gate use them);
 * the download additionally enforces the subscription entitlement server-side,
 * so a non-paid tenant can't fetch the installer even with the direct URL.
 */
@Controller('t/:slug/desktop')
@UseGuards(TenantGuard, PermissionGuard)
export class DesktopController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(DesktopReleaseService) private readonly releases: DesktopReleaseService,
  ) {}

  @RequirePermission('admin.desktop.download')
  @Get('access')
  async access(@TenantCtx() tenant: TenantContext) {
    return this.billing.getDesktopAccess(tenant.id);
  }

  @RequirePermission('admin.desktop.download')
  @Get('release')
  async release(@TenantCtx() tenant: TenantContext) {
    const [access, latest] = await Promise.all([
      this.billing.getDesktopAccess(tenant.id),
      this.releases.getLatest(),
    ]);
    return {
      entitled: access.allowed,
      reason: access.reason,
      billingEnabled: access.billingEnabled,
      available: latest != null,
      version: latest?.version ?? null,
      platforms: {
        mac: latest?.assets.mac != null,
        win: latest?.assets.win != null,
        linux: latest?.assets.linux != null,
      },
    };
  }

  @RequirePermission('admin.desktop.download')
  @Get('download')
  async download(
    @TenantCtx() tenant: TenantContext,
    @Query('platform') platformRaw: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const access = await this.billing.getDesktopAccess(tenant.id);
    if (!access.allowed) {
      throw new ForbiddenException('The Libriant desktop app requires a paid plan.');
    }
    await this.releases.streamAsset(parsePlatform(platformRaw), res);
  }
}

function parsePlatform(raw: string | undefined): DesktopPlatform {
  if (raw === 'mac' || raw === 'win' || raw === 'linux') return raw;
  throw new BadRequestException('platform must be one of: mac, win, linux');
}
