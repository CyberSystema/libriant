import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { controlDb } from '@libriant/db-control';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import type { FeatureKey } from '@libriant/shared';
import { EffectivePlanService } from './effective-plan.service.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { REQUIRES_QUOTA_KEY } from './decorators.js';
import { countUsage, QUOTA_COUNTERS } from './quota-counters.js';

/**
 * Enforce integer-quota features (e.g. `max_books`, `max_members`) on
 * create-style routes. Pattern at the call site:
 *
 *     @Post('books')
 *     @RequiresQuota('max_books')
 *     async create(@Body() body) { ... }
 *
 * Workflow:
 *   1. Read `@RequiresQuota` metadata. No metadata → pass through.
 *   2. Resolve the effective integer limit for the current tenant.
 *   3. Look up the counter for this feature (`QUOTA_COUNTERS`).
 *   4. Count the tenant's current usage.
 *   5. If `used >= limit` → 402 with `{ feature, limit, used }`.
 *
 * Concurrency note: counting before insert leaves a small race window
 * — two concurrent creates can each pass the check and land at limit+1.
 * Acceptable for MVP; advisory locks or a `current_count` column with
 * a CHECK constraint can tighten this when scale demands it.
 */
@Injectable()
export class QuotaInterceptor implements NestInterceptor {
  private readonly logger = new Logger(QuotaInterceptor.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(EffectivePlanService) private readonly effective: EffectivePlanService,
    @Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(REQUIRES_QUOTA_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!feature) return next.handle();

    if (!QUOTA_COUNTERS[feature]) {
      // Refuse to silently no-op: an unregistered counter is a bug, not a
      // green light. Surface it at the API edge.
      throw new HttpException(
        `Quota gate "${feature}" has no counter registered. Add one to QUOTA_COUNTERS.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const req = ctx.switchToHttp().getRequest<Request>();
    // Impersonation short-circuits quotas — admin can clean up records
    // that exceed the plan ceiling without first downgrading the tenant.
    if (req.impersonation) return next.handle();
    if (!req.tenant) {
      throw new HttpException('No tenant on this request.', HttpStatus.BAD_REQUEST);
    }

    const plan = await this.effective.getEffectivePlan(req.tenant.id);
    const fv = plan.features[feature];
    if (fv?.type !== 'int') {
      throw new HttpException(
        `Quota gate "${feature}" doesn't resolve to an integer.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const limit = fv.value;

    const tenantClient = this.tenantPrisma.getClient(req.tenant);
    const used = await countUsage(feature, { tenant: req.tenant, tenantClient, controlDb });
    if (used === null) {
      // Counter returned null even though it's registered — shouldn't happen.
      throw new HttpException(
        `Quota counter for "${feature}" returned null.`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (used >= limit) {
      throw new HttpException(
        {
          statusCode: HttpStatus.PAYMENT_REQUIRED,
          error: 'Payment Required',
          message: `You've reached your library's limit for this plan.`,
          feature,
          limit,
          used,
          currentPlan: plan.plan?.slug ?? null,
        },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return next.handle();
  }
}
