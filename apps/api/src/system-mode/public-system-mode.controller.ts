import { Controller, Get, Inject, Query } from '@nestjs/common';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { SystemModeService } from './system-mode.service.js';
import { NORMAL_MODE, type ResolvedSystemMode } from './system-mode.types.js';

/**
 *   GET /system-mode/current?slug=<slug>
 *
 * Anonymous, cheap, Redis-cached upstream. The web app polls this from
 * its tenant + admin layouts to decide whether to render the takeover
 * page or the under-construction banner. Living under `/system-mode/*`
 * means the system-mode middleware always passes it through (otherwise
 * we'd have a chicken-and-egg problem when checking the mode from a
 * maintenance-blocked client).
 */
@Controller('system-mode')
export class PublicSystemModeController {
  constructor(
    @Inject(SystemModeService) private readonly modes: SystemModeService,
    @Inject(TenantResolverService) private readonly tenantResolver: TenantResolverService,
  ) {}

  @Get('current')
  async current(@Query('slug') slug?: string): Promise<{ mode: ResolvedSystemMode }> {
    // BOOT-01: this is what the web app polls to decide whether to render the
    // takeover page, so it has to answer even while a dependency is down. A
    // 500 here shows the visitor a broken app instead of "back shortly" —
    // hence the safe resolver and the swallowed lookup failure below.
    if (!slug) {
      return { mode: await this.modes.resolveGlobalSafe() };
    }
    const tenant = await this.tenantResolver.resolveBySlug(slug).catch(() => null);
    if (!tenant) {
      // Slug doesn't map to a tenant (or the control DB is unreachable) —
      // surface the global mode rather than a 404 so the web takeover renders
      // correctly for someone who fat-fingered a URL during maintenance.
      return { mode: await this.modes.resolveGlobalSafe() };
    }
    // Both legs (global + tenant) degrade independently inside
    // `resolveEffectiveSafe`. The previous
    // `resolveEffective(...).catch(() => resolveGlobalSafe())` collapsed to the
    // GLOBAL mode whenever the tenant leg threw, so a control-DB error during a
    // tenant-scoped maintenance window made that library report `normal` — and
    // the web app, which polls exactly this to decide whether to render the
    // takeover, showed the ordinary app instead.
    return { mode: await this.modes.resolveEffectiveSafe({ tenantId: tenant.id }) };
  }

  /** Health-style endpoint for ops checks. */
  @Get('normal')
  normal(): { mode: ResolvedSystemMode } {
    return { mode: NORMAL_MODE };
  }
}
