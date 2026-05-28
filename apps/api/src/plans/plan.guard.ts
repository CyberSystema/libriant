import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { FeatureKey } from '@libriant/shared';
import { EffectivePlanService } from './effective-plan.service.js';
import { REQUIRES_FEATURE_KEY } from './decorators.js';

/**
 * Reads the `@RequiresFeature(key)` metadata, looks up the resolved value
 * for the current tenant, and refuses the request with 402 Payment
 * Required if the feature is off.
 *
 * Sits after `TenantGuard` in the @UseGuards chain so `req.tenant` is
 * already populated.
 */
@Injectable()
export class PlanGuard implements CanActivate {
  private readonly logger = new Logger(PlanGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(EffectivePlanService) private readonly effective: EffectivePlanService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(REQUIRES_FEATURE_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!feature) return true; // no gate on this route

    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.tenant) {
      // Shouldn't happen if TenantGuard ran first — defense in depth.
      throw new HttpException('No tenant on this request.', HttpStatus.BAD_REQUEST);
    }
    // Impersonation short-circuits all plan gates — admins can fix data
    // even when the tenant has technically exceeded their plan ceiling.
    if (req.impersonation) return true;

    const plan = await this.effective.getEffectivePlan(req.tenant.id);
    const v = plan.features[feature];
    if (v?.type === 'bool' && v.value === true) return true;

    // 402 — typed payload the UI uses to render the "upgrade your plan"
    // message. We deliberately leak which feature is missing; the tenant
    // already knows what they were trying to do.
    throw new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        message: `This feature isn't included in your library's current plan.`,
        feature,
        currentPlan: plan.plan?.slug ?? null,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
