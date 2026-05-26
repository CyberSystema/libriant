import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { TenantGuard } from './tenant.guard.js';
import { TenantCtx, type TenantContext } from './tenant-context.js';
import { TenantPrismaService } from './tenant-prisma.service.js';

/**
 * Demo endpoints used to verify the whole tenancy stack end-to-end.
 *
 *   GET /t/<slug>/info     → resolved tenant context (proves middleware)
 *   GET /t/<slug>/db-ping  → counts a table in the tenant DB (proves the
 *                            per-tenant Prisma client + LRU pool)
 *
 * These get removed once feature controllers (catalog, members, …) take
 * over the same URL space.
 */
@Controller('t/:slug')
@UseGuards(TenantGuard)
export class TenantDemoController {
  constructor(@Inject(TenantPrismaService) private readonly prisma: TenantPrismaService) {}

  @Get('info')
  info(@TenantCtx() tenant: TenantContext) {
    return {
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        defaultLocale: tenant.defaultLocale,
        status: tenant.status,
        resolvedFrom: tenant.resolvedFrom,
        customSubdomain: tenant.customSubdomain,
      },
    };
  }

  @Get('db-ping')
  async dbPing(@TenantCtx() tenant: TenantContext) {
    const client = this.prisma.getClient(tenant);
    // Three tenant-local counts that prove the connection routes to the
    // *tenant* DB (not the control DB) without leaking anything sensitive.
    const [settings, books, members] = await Promise.all([
      client.tenantSetting.count(),
      client.book.count(),
      client.member.count(),
    ]);
    return {
      tenantId: tenant.id,
      slug: tenant.slug,
      counts: { tenant_settings: settings, books, members },
      cachedClients: this.prisma.size(),
    };
  }
}
