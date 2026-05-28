import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { BillingService } from './billing.service.js';
import { OpenPortalDto, StartCheckoutDto } from './billing.dto.js';

/**
 * Library-facing billing endpoints.
 *
 *   GET  /t/:slug/billing               — current subscription snapshot
 *   POST /t/:slug/billing/checkout      — start a Stripe Checkout for an upgrade
 *   POST /t/:slug/billing/portal        — open the Stripe Customer Portal
 *   POST /t/:slug/billing/cancel        — cancel at period end (Stripe only)
 *   POST /t/:slug/billing/resume        — undo a pending cancellation
 *
 * Everything sits behind TenantGuard so a logged-in user can only see their
 * own library's billing state. There's no separate "billing manager" role
 * yet — any signed-in user of the tenant can view + change. Step 18 wires
 * a `role IN ('owner','admin')` gate when the staff-role system lands.
 */
@Controller('t/:slug/billing')
@UseGuards(TenantGuard)
export class BillingController {
  constructor(@Inject(BillingService) private readonly svc: BillingService) {}

  @Get()
  async current(@TenantCtx() tenant: TenantContext) {
    return this.svc.getSnapshot(tenant.id);
  }

  @Get('plans')
  async availablePlans(@TenantCtx() tenant: TenantContext) {
    return { plans: await this.svc.listAvailablePlans(tenant.id) };
  }

  @Post('checkout')
  async checkout(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(StartCheckoutDto, raw);
    return this.svc.startCheckout(tenant.id, dto);
  }

  @Post('portal')
  async portal(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(OpenPortalDto, raw ?? {});
    return this.svc.openCustomerPortal(tenant.id, dto);
  }

  @Post('cancel')
  async cancel(@TenantCtx() tenant: TenantContext) {
    return this.svc.cancelAtPeriodEnd(tenant.id);
  }

  @Post('resume')
  async resume(@TenantCtx() tenant: TenantContext) {
    return this.svc.resumeSubscription(tenant.id);
  }
}
