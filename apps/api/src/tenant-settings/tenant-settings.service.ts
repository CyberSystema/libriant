import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@libriant/db-tenant';
import type { TenantContext } from '../tenancy/tenant-context.js';
import type { TenantActor } from '../tenancy/tenant-actor.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { TenantAuditService } from '../tenancy/tenant-audit.service.js';
import { EffectivePlanService } from '../plans/effective-plan.service.js';
import type { NotificationTemplate, UpdateTenantSettingsDto } from './tenant-settings.dto.js';

/** Reminder kinds that can carry a custom template. */
const TEMPLATE_KINDS = ['dueSoon', 'overdue', 'holdReady'] as const;
const SUBJECT_MAX = 200;
const BODY_MAX = 4000;

/** Whitelist kinds, keep only string subject/body, trim + cap length. */
function sanitizeTemplates(input: unknown): Record<string, NotificationTemplate> {
  const out: Record<string, NotificationTemplate> = {};
  if (!input || typeof input !== 'object') return out;
  const obj = input as Record<string, unknown>;
  for (const kind of TEMPLATE_KINDS) {
    const v = obj[kind];
    if (!v || typeof v !== 'object') continue;
    const entry: NotificationTemplate = {};
    const subject = (v as Record<string, unknown>).subject;
    const body = (v as Record<string, unknown>).body;
    if (typeof subject === 'string' && subject.trim())
      entry.subject = subject.trim().slice(0, SUBJECT_MAX);
    if (typeof body === 'string' && body.trim()) entry.body = body.trim().slice(0, BODY_MAX);
    if (entry.subject || entry.body) out[kind] = entry;
  }
  return out;
}

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
  notifyDueSoon: boolean;
  dueSoonDays: number;
  notifyOverdue: boolean;
  notifyHoldReady: boolean;
  notificationTemplates: Record<string, NotificationTemplate>;
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
  'notifyDueSoon',
  'dueSoonDays',
  'notifyOverdue',
  'notifyHoldReady',
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

    // notificationTemplates is JSON, so it can't ride the scalar === diff above.
    if (patch.notificationTemplates !== undefined) {
      const sanitized = sanitizeTemplates(patch.notificationTemplates);
      const existingTemplates = (existing.notificationTemplates ?? {}) as Record<string, unknown>;
      if (JSON.stringify(sanitized) !== JSON.stringify(existingTemplates)) {
        data.notificationTemplates = sanitized as Prisma.InputJsonValue;
        before.notificationTemplates = existingTemplates;
        after.notificationTemplates = sanitized;
      }
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
      notifyDueSoon: boolean;
      dueSoonDays: number;
      notifyOverdue: boolean;
      notifyHoldReady: boolean;
      notificationTemplates: unknown;
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
      notifyDueSoon: s.notifyDueSoon,
      dueSoonDays: s.dueSoonDays,
      notifyOverdue: s.notifyOverdue,
      notifyHoldReady: s.notifyHoldReady,
      notificationTemplates: sanitizeTemplates(s.notificationTemplates),
      reservationsAllowedByPlan,
    };
  }
}
