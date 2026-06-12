import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import type { UpdateTenantSettingsDto } from './tenant-settings.dto.js';

/** The settings + feature switches the tenant admin controls, plus the one
 *  capability that's gated by the subscription rather than the library. */
export type TenantSettingsView = {
  currency: string;
  loanPeriodDays: number;
  renewalsEnabled: boolean;
  maxRenewals: number;
  overdueFinesEnabled: boolean;
  finePerDayCents: number;
  fineCapCents: number;
  lostItemFeesEnabled: boolean;
  lostItemDefaultFeeCents: number;
  reservationsEnabled: boolean;
  holdPickupHours: number;
  maxActiveLoans: number;
  /** Whether the subscription permits reservations at all. When false, the
   *  reservations switch can't be turned on and the UI should say so. */
  reservationsAllowedByPlan: boolean;
};

/** Fields a librarian can both see and (as admin) change. */
const EDITABLE_KEYS = [
  'currency',
  'loanPeriodDays',
  'renewalsEnabled',
  'maxRenewals',
  'overdueFinesEnabled',
  'finePerDayCents',
  'fineCapCents',
  'lostItemFeesEnabled',
  'lostItemDefaultFeeCents',
  'reservationsEnabled',
  'holdPickupHours',
  'maxActiveLoans',
] as const;

@Injectable()
export class TenantSettingsService {
  constructor(
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
    @Inject(TenantAuditService) private readonly audit: TenantAuditService,
    @Inject(EffectivePlanService) private readonly plans: EffectivePlanService,
  ) {}

  async get(tenant: TenantContext): Promise<TenantSettingsView> {
    const client = this.tenantPrisma.getClient(tenant);
    const [settings, reservationsAllowedByPlan] = await Promise.all([
      client.tenantSetting.findUnique({ where: { id: 1 } }),
      this.plans.getBool(tenant.id, 'reservations_enabled'),
    ]);
    if (!settings) {
      throw new Error('Tenant settings row missing; tenant DB is in a corrupt state.');
    }
    return this.toView(settings, reservationsAllowedByPlan);
  }

  async update(
    tenant: TenantContext,
    patch: UpdateTenantSettingsDto,
    actor: TenantActor,
  ): Promise<TenantSettingsView> {
    const client = this.tenantPrisma.getClient(tenant);
    const existing = await client.tenantSetting.findUnique({ where: { id: 1 } });
    if (!existing) {
      throw new Error('Tenant settings row missing; tenant DB is in a corrupt state.');
    }

    // Reservations are layered under the plan: a library can turn them OFF
    // freely, but can only turn them ON when the subscription permits.
    const reservationsAllowedByPlan = await this.plans.getBool(tenant.id, 'reservations_enabled');
    if (patch.reservationsEnabled === true && !reservationsAllowedByPlan) {
      throw new BadRequestException(
        "Your plan doesn't include reservations. Upgrade to turn this on.",
      );
    }

    // Build the update from only the keys that actually change, so the audit
    // diff is meaningful and we don't bump updatedAt for no-op saves.
    const data: Prisma.TenantSettingUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of EDITABLE_KEYS) {
      const next = patch[key];
      if (next === undefined) continue;
      if (existing[key] === next) continue;
      (data as Record<string, unknown>)[key] = next;
      before[key] = existing[key];
      after[key] = next;
    }

    if (Object.keys(data).length === 0) {
      return this.toView(existing, reservationsAllowedByPlan);
    }

    const updated = await client.tenantSetting.update({ where: { id: 1 }, data });
    await this.audit.record(tenant, actor, {
      action: 'settings.updated',
      targetType: 'tenant_settings',
      targetId: '1',
      before,
      after,
    });
    return this.toView(updated, reservationsAllowedByPlan);
  }

  private toView(
    s: {
      currency: string;
      loanPeriodDays: number;
      renewalsEnabled: boolean;
      maxRenewals: number;
      overdueFinesEnabled: boolean;
      finePerDayCents: number;
      fineCapCents: number;
      lostItemFeesEnabled: boolean;
      lostItemDefaultFeeCents: number;
      reservationsEnabled: boolean;
      holdPickupHours: number;
      maxActiveLoans: number;
    },
    reservationsAllowedByPlan: boolean,
  ): TenantSettingsView {
    return {
      currency: s.currency,
      loanPeriodDays: s.loanPeriodDays,
      renewalsEnabled: s.renewalsEnabled,
      maxRenewals: s.maxRenewals,
      overdueFinesEnabled: s.overdueFinesEnabled,
      finePerDayCents: s.finePerDayCents,
      fineCapCents: s.fineCapCents,
      lostItemFeesEnabled: s.lostItemFeesEnabled,
      lostItemDefaultFeeCents: s.lostItemDefaultFeeCents,
      reservationsEnabled: s.reservationsEnabled,
      holdPickupHours: s.holdPickupHours,
      maxActiveLoans: s.maxActiveLoans,
      reservationsAllowedByPlan,
    };
  }
}
