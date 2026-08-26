import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { EffectivePlanService } from './effective-plan.service.js';
import { collectUsage } from './plan-usage.js';

/**
 * A library's own plan and its own numbers.
 *
 *   GET /t/:slug/plan        — the effective plan, with the layer each value came from
 *   GET /t/:slug/plan/usage  — counters vs. those limits
 *
 * launch-readiness-17: both of these used to live on `PlanDemoController`,
 * behind `NonProductionOnlyGuard` — correct for that controller, which also
 * carries a real unvalidated book write, and wrong for these two. In production
 * they 404'd, so the whole product had no screen anywhere showing a librarian
 * how much of their plan they had spent. The first signal that a library was
 * near its cap would have been the 402 itself, in the middle of accessioning a
 * delivery. Splitting them out is the fix; the demo write stays where it was.
 *
 * Read-only and tenant-scoped: `TenantGuard` proves the caller belongs to this
 * library, `@Roles` keeps it to the people who can act on the answer (a
 * librarian cannot upgrade the plan; an owner or admin can). The counters are
 * the tenant's own rows plus its own `staff_seats` / `storageUsedBytes` on the
 * control plane — nothing here reaches another library.
 *
 * Cost: one `COUNT(*)` per int feature, and `book.count` is a sequential scan
 * (measured at 67.7 ms on the 400,000-title fixture — see the note in
 * quota.interceptor.ts). That is fine on a page a librarian opens now and then
 * and is why nothing calls this on a hot path.
 */
@Controller('t/:slug')
@UseGuards(TenantGuard, RolesGuard)
@Roles('owner', 'admin')
export class PlanUsageController {
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
    // The EFFECTIVE plan, not the contracted one: this screen must show the
    // library what is being enforced against it right now. While subscriptions
    // are off that is "no ceiling", and saying so is the honest answer — the
    // operator's pre-flight is the caller that wants the contracted limits.
    const plan = await this.effective.getEffectivePlan(tenant.id);
    const tenantClient = this.tenantPrisma.getClient(tenant);
    return { plan: plan.plan, usage: await collectUsage(plan, { tenant, tenantClient }) };
  }
}
