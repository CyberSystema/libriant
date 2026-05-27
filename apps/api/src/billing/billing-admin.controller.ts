import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { validateDto } from '../auth/validate-dto.js';
import { BillingService } from './billing.service.js';
import { AdminSetPaidUntilDto, AdminSetPlanDto } from './billing.dto.js';

/**
 * Light-touch admin endpoints for the billing flow. Full Libriant-staff
 * authentication ships in Step 18 — for Step 16 these routes are mounted
 * at `/admin/billing/*` and not wired behind an admin guard. That's a
 * **temporary** seam to let the verification drills exercise the manual-
 * billing path and force-set tenant plans without the support-session
 * dance. Step 18 will gate this controller under the real admin auth.
 *
 *   GET  /admin/billing/tenants/:tenantId
 *   POST /admin/billing/tenants/:tenantId/set-plan
 *   POST /admin/billing/tenants/:tenantId/set-paid-until    (manual mode only)
 */
@Controller('admin/billing/tenants/:tenantId')
export class BillingAdminController {
  constructor(@Inject(BillingService) private readonly svc: BillingService) {}

  @Get()
  async get(@Param('tenantId') tenantId: string) {
    const sub = await controlDb.subscription.findUnique({
      where: { tenantId },
      include: { plan: true, tenant: { select: { slug: true, name: true } } },
    });
    if (!sub) return { tenantId, found: false };
    return {
      tenantId,
      tenantSlug: sub.tenant.slug,
      tenantName: sub.tenant.name,
      plan: { slug: sub.plan.slug, name: sub.plan.name, billingMode: sub.plan.billingMode },
      status: sub.status,
      paidUntil: sub.paidUntil,
      graceUntil: sub.graceUntil,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canceledAt: sub.canceledAt,
      stripeSubscriptionId: sub.stripeSubscriptionId,
    };
  }

  @Post('set-plan')
  async setPlan(@Param('tenantId') tenantId: string, @Body() raw: unknown) {
    const dto = await validateDto(AdminSetPlanDto, raw);
    return this.svc.applyAdminPlanChange(tenantId, dto);
  }

  @Post('set-paid-until')
  async setPaidUntil(@Param('tenantId') tenantId: string, @Body() raw: unknown) {
    const dto = await validateDto(AdminSetPaidUntilDto, raw);
    return this.svc.applyManualPayment(tenantId, dto);
  }
}
