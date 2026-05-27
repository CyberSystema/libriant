import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { EffectivePlanService } from './effective-plan.service.js';
import { PlanGuard } from './plan.guard.js';
import { QuotaInterceptor } from './quota.interceptor.js';
import { RequiresFeature, RequiresQuota } from './decorators.js';
import { countUsage, KNOWN_QUOTA_KEYS } from './quota-counters.js';

/**
 * Tenant-scoped endpoints that expose the plan layer for the UI and that
 * exercise the guard + interceptor end-to-end.
 *
 *   GET  /t/:slug/plan                — full effective plan (with sources)
 *   GET  /t/:slug/plan/usage          — counters vs. effective limits
 *   GET  /t/:slug/demo/reservations   — gated by `reservations_enabled`
 *   POST /t/:slug/demo/books          — gated by `max_books`
 *
 * The real catalog/members controllers (Step 11+) will use the same
 * decorators against their real DTOs; this controller is just the
 * end-to-end smoke test until they land.
 */
@Controller('t/:slug')
@UseGuards(TenantGuard, PlanGuard)
@UseInterceptors(QuotaInterceptor)
export class PlanDemoController {
  constructor(
    @Inject(EffectivePlanService) private readonly effective: EffectivePlanService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
  ) {}

  @Get('plan')
  async plan(@TenantCtx() tenant: TenantContext) {
    return this.effective.getEffectivePlan(tenant.id);
  }

  @Get('plan/usage')
  async usage(@TenantCtx() tenant: TenantContext) {
    const plan = await this.effective.getEffectivePlan(tenant.id);
    const tenantClient = this.tenantPrisma.getClient(tenant);
    const rows: Array<{
      feature: string;
      limit: number;
      used: number | null;
      unit: string | null;
      source: string;
    }> = [];
    for (const key of KNOWN_QUOTA_KEYS) {
      const fv = plan.features[key];
      if (fv?.type !== 'int') continue;
      const used = await countUsage(key, { tenant, tenantClient, controlDb });
      rows.push({
        feature: key,
        limit: fv.value,
        used,
        unit: fv.unit ?? null,
        source: fv.source,
      });
    }
    return { plan: plan.plan, usage: rows };
  }

  // -------- Demo: feature-flag gate ---------------------------------------

  @Get('demo/reservations')
  @RequiresFeature('reservations_enabled')
  async listReservations() {
    return { reservations: [] };
  }

  // -------- Demo: integer-quota gate -------------------------------------

  @Post('demo/books')
  @RequiresQuota('max_books')
  async createBook(@TenantCtx() tenant: TenantContext, @Body() body: unknown) {
    if (typeof body !== 'object' || body === null) {
      throw new BadRequestException('JSON object required.');
    }
    const b = body as Record<string, unknown>;
    const title =
      typeof b.title === 'string' && b.title.trim().length ? b.title.trim() : 'Untitled';
    const client = this.tenantPrisma.getClient(tenant);
    const created = await client.book.create({
      data: {
        title,
        sortTitle: title.toLowerCase(),
        searchText: title.toLowerCase(),
      },
      select: { id: true, title: true, createdAt: true },
    });
    return created;
  }
}
