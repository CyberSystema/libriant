import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { loadEnv } from '../config/env.js';
import { TenantGuard } from '../tenancy/tenant.guard.js';
import { TenantCtx, type TenantContext } from '../tenancy/tenant-context.js';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import { PlanGuard } from './plan.guard.js';
import { QuotaInterceptor } from './quota.interceptor.js';
import { RequiresFeature, RequiresQuota } from './decorators.js';
import { RequirePermission } from '../authz/permission.decorator.js';
import { PermissionGuard } from '../authz/permission.guard.js';

/**
 * PQF-1: this controller is a developer smoke-test for the plan layer. Its
 * `POST /demo/books` route performs a REAL, unvalidated book write that
 * bypasses the race-safe quota authority (BooksService.create's
 * enforceWithinTx) — that must not be reachable in production, and it is the
 * whole reason the guard below exists.
 *
 * The clean fix is to not register the controller in a prod build, but that
 * lives in PlansModule. As a self-contained guard, every demo route is gated by
 * this: outside development it returns 404, so the routes behave as if they were
 * never mounted. The guard is constructed standalone (no DI / no `design:
 * paramtypes` under tsx), matching the project's other hand-built guards.
 */
@Injectable()
export class NonProductionOnlyGuard implements CanActivate {
  // Reachable in development + test (where the smoke-test belongs); absent in
  // production. Matches the "register only when NODE_ENV !== 'production'" intent.
  private readonly enabled = loadEnv().nodeEnv !== 'production';

  canActivate(_ctx: ExecutionContext): boolean {
    if (this.enabled) return true;
    // 404, not 403 — the endpoint should look absent, not forbidden.
    throw new NotFoundException();
  }
}

/**
 * Tenant-scoped endpoints that exercise the guard + interceptor end-to-end.
 *
 *   GET  /t/:slug/demo/reservations   — gated by `reservations_enabled`
 *   POST /t/:slug/demo/books          — gated by `max_books`
 *
 * The real catalog/members controllers (Step 11+) will use the same
 * decorators against their real DTOs; this controller is just the
 * end-to-end smoke test until they land.
 *
 * `GET /t/:slug/plan` and `GET /t/:slug/plan/usage` used to be here too, and
 * were 404 in production as collateral damage from the guard above — a library
 * could not see its own numbers anywhere in the product (launch-readiness-17).
 * They now live on `PlanUsageController`, which carries no demo write and so
 * needs no production gate.
 */
@Controller('t/:slug')
// NonProductionOnlyGuard MUST run first so prod requests 404 before TenantGuard
// warms a tenant DB pool or PlanGuard touches the plan layer (PQF-1).
// A2-03: also role-gate (defence-in-depth) so even in dev/test the demo write
// isn't exposed to a low-privilege role.
@UseGuards(NonProductionOnlyGuard, TenantGuard, PermissionGuard, PlanGuard)
@UseInterceptors(QuotaInterceptor)
export class PlanDemoController {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  // -------- Demo: feature-flag gate ---------------------------------------

  @RequirePermission('admin.settings.edit')
  @Get('demo/reservations')
  @RequiresFeature('reservations_enabled')
  async listReservations() {
    return { reservations: [] };
  }

  // -------- Demo: integer-quota gate -------------------------------------

  @RequirePermission('admin.settings.edit')
  @Post('demo/books')
  @RequiresQuota('max_books')
  async createBook(@TenantCtx() tenant: TenantContext, @Body() body: unknown) {
    if (typeof body !== 'object' || body === null) {
      throw new BadRequestException('JSON object required.');
    }
    const b = body as Record<string, unknown>;
    const title =
      typeof b.title === 'string' && b.title.trim().length ? b.title.trim() : 'Untitled';
    const client = this.tenantPrisma.getClient(tenant);
    const created = await client.book.create({
      data: {
        title,
        sortTitle: title.toLowerCase(),
        searchText: title.toLowerCase(),
      },
      select: { id: true, title: true, createdAt: true },
    });
    return created;
  }
}
