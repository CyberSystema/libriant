import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { BillingService } from './billing.service.js';
import { OpenPortalDto, SelectPlanDto, StartCheckoutDto } from './billing.dto.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * Library-facing billing endpoints.
 *
 *   GET  /t/:slug/billing               — current subscription snapshot
 *   GET  /t/:slug/billing/gate          — cheap chooser-gate check (all roles)
 *   GET  /t/:slug/billing/plans         — available plans
 *   POST /t/:slug/billing/checkout      — start Stripe Checkout            (admin)
 *   POST /t/:slug/billing/select        — record a free-plan choice        (admin)
 *   POST /t/:slug/billing/portal        — open the Stripe Customer Portal  (admin)
 *   POST /t/:slug/billing/cancel        — cancel at period end             (admin)
 *   POST /t/:slug/billing/resume        — undo a pending cancellation      (admin)
 *
 * Reads stay open to all staff (the layout's chooser gate + dashboard read
 * them); the state-changing actions require a library admin (owner/admin).
 */
@Controller('t/:slug/billing')
@UseGuards(TenantGuard, PermissionGuard)
export class BillingController {
  constructor(@Inject(BillingService) private readonly svc: BillingService) {}

  @RequirePermission('billing.read')
  @Get()
  async current(@TenantCtx() tenant: TenantContext) {
    return this.svc.getSnapshot(tenant.id);
  }

  @RequirePermission('billing.read')
  @Get('gate')
  async gate(@TenantCtx() tenant: TenantContext) {
    return this.svc.getGate(tenant.id);
  }

  @RequirePermission('billing.read')
  @Get('plans')
  async availablePlans(@TenantCtx() tenant: TenantContext) {
    return { plans: await this.svc.listAvailablePlans(tenant.id) };
  }

  @RequirePermission('billing.manage')
  @Post('checkout')
  async checkout(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(StartCheckoutDto, raw);
    return this.svc.startCheckout(tenant.id, dto);
  }

  @RequirePermission('billing.manage')
  @Post('select')
  async select(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(SelectPlanDto, raw);
    return this.svc.selectPlan(tenant.id, dto);
  }

  @RequirePermission('billing.manage')
  @Post('portal')
  async portal(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(OpenPortalDto, raw ?? {});
    return this.svc.openCustomerPortal(tenant.id, dto);
  }

  @RequirePermission('billing.manage')
  @Post('cancel')
  async cancel(@TenantCtx() tenant: TenantContext) {
    return this.svc.cancelAtPeriodEnd(tenant.id);
  }

  @RequirePermission('billing.manage')
  @Post('resume')
  async resume(@TenantCtx() tenant: TenantContext) {
    return this.svc.resumeSubscription(tenant.id);
  }
}
