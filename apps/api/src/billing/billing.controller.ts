import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { validateDto } from '../auth/validate-dto.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { RolesGuard } from '../tenancy/roles.guard.js';
import { Roles } from '../tenancy/roles.decorator.js';
import { BillingService } from './billing.service.js';
import { OpenPortalDto, SelectPlanDto, StartCheckoutDto } from './billing.dto.js';

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
@UseGuards(TenantGuard, RolesGuard)
export class BillingController {
  constructor(@Inject(BillingService) private readonly svc: BillingService) {}

  @Get()
  async current(@TenantCtx() tenant: TenantContext) {
    return this.svc.getSnapshot(tenant.id);
  }

  @Get('gate')
  async gate(@TenantCtx() tenant: TenantContext) {
    return this.svc.getGate(tenant.id);
  }

  @Get('plans')
  async availablePlans(@TenantCtx() tenant: TenantContext) {
    return { plans: await this.svc.listAvailablePlans(tenant.id) };
  }

  @Post('checkout')
  @Roles('owner', 'admin')
  async checkout(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(StartCheckoutDto, raw);
    return this.svc.startCheckout(tenant.id, dto);
  }

  @Post('select')
  @Roles('owner', 'admin')
  async select(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(SelectPlanDto, raw);
    return this.svc.selectPlan(tenant.id, dto);
  }

  @Post('portal')
  @Roles('owner', 'admin')
  async portal(@TenantCtx() tenant: TenantContext, @Body() raw: unknown) {
    const dto = await validateDto(OpenPortalDto, raw ?? {});
    return this.svc.openCustomerPortal(tenant.id, dto);
  }

  @Post('cancel')
  @Roles('owner', 'admin')
  async cancel(@TenantCtx() tenant: TenantContext) {
    return this.svc.cancelAtPeriodEnd(tenant.id);
  }

  @Post('resume')
  @Roles('owner', 'admin')
  async resume(@TenantCtx() tenant: TenantContext) {
    return this.svc.resumeSubscription(tenant.id);
  }
}
