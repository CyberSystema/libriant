import { Controller, Get, Inject, Logger, UseGuards } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AnyAdmin } from '../admin/admin-roles.decorator.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TENANT_RUNTIME_SELECT, runtimeDbUrl, readSchemaMajors } from '../tenancy/tenant-db-url.js';
import { EffectivePlanService } from './effective-plan.service.js';
import { breaches, collectUsage, type UsageRow } from './plan-usage.js';

type OverCapTenant = {
  slug: string;
  name: string;
  plan: string | null;
  breaches: Array<{ feature: string; limit: number; used: number }>;
};

/**
 * billing-16 — the go-live pre-flight that could not be performed.
 *
 * The runbook has always said, in words, "check no existing library is already
 * over its cap before you switch enforcement on". Nothing in the product could
 * answer that. The only usage route was tenant-scoped, one library at a time,
 * and 404 in production; the counters live in as many databases as there are
 * libraries, so no single SQL statement can be handed to an operator either. So
 * the instruction was a green tick nobody could earn, and the alternative to
 * earning it is flipping the switch blind: every library that grew past a cap
 * during the free period meets it as a 402 on the Monday morning after.
 *
 *   GET /admin/plan-usage/over-cap
 *
 * Three properties this has to have, each of which is a way the check could
 * have been useless:
 *
 *   1. It counts against the CONTRACTED plan (`getPlanAsContracted`), not the
 *      effective one. Before the flip every effective limit is the unlimited
 *      sentinel, so asked the ordinary way the answer is always "nobody".
 *   2. It counts through `QUOTA_COUNTERS` — the same counters `QuotaInterceptor`
 *      refuses on — so the answer is about the refusal a librarian will meet
 *      rather than a second, similar-looking query.
 *   3. A library whose database it could not read lands in `unreadable`, and
 *      `ok` is false while that list is non-empty. "We could not look" must not
 *      read as "nothing found".
 *
 * Any admin tier may read it: it is a census of numbers the platform already
 * holds, it is the input to a decision support is asked about, and there is
 * nothing in the response that identifies a person.
 *
 * Cost is real — one `COUNT(*)` per int feature per library, and `book.count`
 * is a sequential scan. Tenants are walked one at a time rather than in
 * parallel, so the report costs one extra tenant connection at a time instead
 * of one per library (performance-06: this process shares a bounded Postgres
 * connection budget with every request being served while it runs).
 */
@Controller('admin/plan-usage')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@AnyAdmin()
export class AdminPlanUsageController {
  private readonly logger = new Logger(AdminPlanUsageController.name);

  constructor(
    @Inject(EffectivePlanService) private readonly effective: EffectivePlanService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(PlatformSettingsService) private readonly settings: PlatformSettingsService,
  ) {}

  @Get('over-cap')
  async overCap() {
    // `TenantStatus` is active | suspended | archived. A suspended library is
    // already refused at the middleware and an archived one is gone, so neither
    // can meet a 402; the active ones are who the flip lands on.
    const tenants = await controlDb.tenant.findMany({
      where: { status: 'active' },
      select: { ...TENANT_RUNTIME_SELECT, name: true },
      orderBy: { slug: 'asc' },
    });
    // One query for which libraries have been cut over (2.0 phase 20f/20g).
    const schemaMajors = await readSchemaMajors(tenants.map((t) => t.id));

    const overCap: OverCapTenant[] = [];
    const unreadable: Array<{ slug: string; error: string }> = [];

    for (const tenant of tenants) {
      let rows: UsageRow[];
      let planSlug: string | null;
      try {
        const plan = await this.effective.getPlanAsContracted(tenant.id);
        planSlug = plan.plan?.slug ?? null;
        // The RUNTIME credential, not `tenants.db_url` — an admin report reads
        // library data and has no business holding the superuser string.
        // `schemaMajor` rides along (2.0 phase 20g) so the 2.0 client binds to
        // the schema this library actually has — a fleet report counts across
        // both populations and would otherwise query `lbr2` on a promoted one.
        const runtime = {
          id: tenant.id,
          dbUrl: runtimeDbUrl(tenant),
          schemaMajor: schemaMajors.get(tenant.id),
        };
        const tenantClient = this.tenantPrisma.getClient(runtime);
        const tenantClientV2 = this.tenantPrisma.getClientV2(runtime);
        rows = await collectUsage(plan, { tenant: runtime, tenantClient, tenantClientV2 });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`over-cap: could not measure tenant ${tenant.slug}: ${message}`);
        unreadable.push({ slug: tenant.slug, error: message });
        continue;
      }
      const over = breaches(rows);
      if (over.length) {
        overCap.push({
          slug: tenant.slug,
          name: tenant.name,
          plan: planSlug,
          breaches: over.map((r) => ({ feature: r.feature, limit: r.limit, used: r.used ?? 0 })),
        });
      }
    }

    return {
      checkedAt: new Date().toISOString(),
      // What the platform is doing right now, so the report cannot be mistaken
      // for a statement about a switch that has already been thrown.
      billingEnabled: await this.settings.billingEnabled().catch(() => null),
      tenantsChecked: tenants.length,
      overCap,
      unreadable,
      ok: overCap.length === 0 && unreadable.length === 0,
    };
  }
}
