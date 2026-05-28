import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { validateDto } from '../auth/validate-dto.js';
import { TenantResolverService } from '../tenancy/tenant-resolver.service.js';
import { SetTenantTagsDto } from './announcement.dto.js';
import { AnnouncementDeliveryService } from './announcement-delivery.service.js';

/**
 * Per-tenant tag editor. Tags are arbitrary lowercase strings used by
 * announcement audiences (`{ tags: ['eu-region','beta'] }`) and, later,
 * by per-tenant system mode. Tags are tenant metadata — they don't change
 * billing or feature access.
 *
 *   GET /admin/tenants/:tenantId/tags          — current tag list + suggestions
 *   PUT /admin/tenants/:tenantId/tags          — overwrite tags
 *
 * GET also returns the set of tags used across the whole platform so
 * the composer can offer autocomplete.
 */
@Controller('admin/tenants/:tenantId/tags')
@UseGuards(AdminAuthGuard)
export class AdminTenantTagsController {
  constructor(
    @Inject(AnnouncementDeliveryService)
    private readonly deliveries: AnnouncementDeliveryService,
    @Inject(TenantResolverService) private readonly tenantResolver: TenantResolverService,
  ) {}

  @Get()
  async get(@Param('tenantId') tenantId: string) {
    const tenant = await controlDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, tags: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    const allRows = await controlDb.tenant.findMany({ select: { tags: true } });
    const seen = new Set<string>();
    for (const r of allRows) for (const t of r.tags) seen.add(t);
    return {
      tags: tenant.tags,
      knownTags: Array.from(seen).sort(),
    };
  }

  @Put()
  @HttpCode(200)
  async set(@Param('tenantId') tenantId: string, @Body() raw: unknown) {
    const dto = await validateDto(SetTenantTagsDto, raw);
    const updated = await controlDb.tenant.update({
      where: { id: tenantId },
      data: { tags: dto.tags },
      select: { id: true, slug: true, customSubdomain: true, tags: true },
    });
    // Two caches to bust:
    //  1) The per-tenant *resolver* cache, since the `tags` array is baked
    //     into the TenantContext that TenantMiddleware attaches to every
    //     request. Without this, downstream code would keep seeing the old
    //     tag set for up to `TENANT_CACHE_TTL_SEC` (default 5 min).
    //  2) The per-(tenant,user) announcement active set — tag changes can
    //     pull a tenant into or out of an audience.
    await this.tenantResolver.invalidate({
      slug: updated.slug,
      customSubdomain: updated.customSubdomain,
    });
    await this.deliveries.bustTenant(updated.id);
    return { tenant: { id: updated.id, tags: updated.tags } };
  }
}
