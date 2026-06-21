import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { controlDb } from '@libriant/db-control';
import { validateDto } from '../auth/validate-dto.js';
import { AdminAuthGuard, AdminSess } from '../admin/admin-auth.guard.js';
import { AdminRolesGuard } from '../admin/admin-roles.guard.js';
import { AdminRoles } from '../admin/admin-roles.decorator.js';
import type { AdminSessionPayload } from '../admin/admin-session.service.js';
import { adminAuditActor } from '../platform/admin-audit.js';
import { BillingService } from './billing.service.js';
import { AdminSetPaidUntilDto, AdminSetPlanDto } from './billing.dto.js';

/**
 * Admin endpoints for the billing flow. Gated behind `AdminAuthGuard`
 * since Step 18 — anonymous calls now return 401 instead of mutating
 * tenant state.
 *
 *   GET  /admin/billing/tenants/:tenantId
 *   POST /admin/billing/tenants/:tenantId/set-plan
 *   POST /admin/billing/tenants/:tenantId/set-paid-until    (manual mode only)
 */
@Controller('admin/billing/tenants/:tenantId')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
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
  @AdminRoles('owner')
  async setPlan(
    @Param('tenantId') tenantId: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(AdminSetPlanDto, raw);
    return this.svc.applyAdminPlanChange(tenantId, dto, adminAuditActor(req, admin));
  }

  @Post('set-paid-until')
  @AdminRoles('owner')
  async setPaidUntil(
    @Param('tenantId') tenantId: string,
    @AdminSess() admin: AdminSessionPayload,
    @Req() req: Request,
    @Body() raw: unknown,
  ) {
    const dto = await validateDto(AdminSetPaidUntilDto, raw);
    return this.svc.applyManualPayment(tenantId, dto, adminAuditActor(req, admin));
  }
}
