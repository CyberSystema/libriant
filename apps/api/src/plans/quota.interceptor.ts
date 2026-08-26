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
import { EffectivePlanService, isUnlimitedInt } from './effective-plan.service.js';
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
 *   3. If the limit is the "no ceiling" sentinel → pass through WITHOUT
 *      counting. See `isUnlimitedInt` below; this is performance-05.
 *   4. Look up the counter for this feature (`QUOTA_COUNTERS`).
 *   5. Count the tenant's current usage.
 *   6. If `used >= limit` → 402 with `{ feature, limit, used }`.
 *
 * Concurrency note: counting before insert leaves a small race window
 * — two concurrent creates can each pass the check and land at limit+1.
 * That is why routes whose resource has a race-safe authority
 * (`QuotaService.enforceWithinTx`, which counts and inserts inside ONE
 * transaction behind a per-quota advisory lock) do NOT also carry
 * `@RequiresQuota`: the pre-check is the weaker duplicate of a check that
 * already runs, and on a large table it is a second full scan. See the note
 * on `BooksController.create`.
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

    // performance-05 — THE COUNT THE REQUEST PATH WAS STILL PAYING.
    //
    // `BooksService.create` was taught to skip its own count when the ceiling
    // is the sentinel, and a unit test proved it, but the unit test builds the
    // service directly and never sees this interceptor. Over HTTP,
    // `BooksController` is `@UseInterceptors(QuotaInterceptor)` with
    // `@RequiresQuota('max_books')`, and the line below used to call
    // `countUsage(...)` unconditionally — `book.count({ where: { archivedAt:
    // null } })`, which nothing indexes. Measured on the audit's 400,000-title
    // fixture, on the literal statement Prisma emits:
    //
    //   Seq Scan on books   Buffers: shared read=13333   Execution Time: 67.7 ms
    //
    // (re-measured 2026-08-26 on the 400,000-title fixture, 398,000 of them
    // active, with EXPLAIN (ANALYZE, BUFFERS) on that exact statement)
    //
    // So in the configuration we actually ship — BILLING_ENABLED=false, where
    // `unlimitedPlan()` rewrites EVERY int feature to UNLIMITED_INT — every
    // single book create paid a 104 MB scan of the catalogue through a 128 MB
    // shared_buffers pool that every library on the box shares, purely to
    // compare the answer against Number.MAX_SAFE_INTEGER.
    //
    // There is no ceiling to be at, so there is nothing worth counting. Ask
    // (`isUnlimitedInt`) rather than compute: the sentinel is a magnitude, and
    // arithmetic on it is what made a bigint overflow 500 every upload
    // (data-integrity-01).
    if (isUnlimitedInt(limit)) return next.handle();

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
