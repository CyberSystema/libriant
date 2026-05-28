import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { controlDb } from '@libriant/db-control';
import { AdminAuthGuard } from './admin-auth.guard.js';

/**
 *   GET /admin/tenants?status=&planSlug=&q=&limit=
 *   GET /admin/tenants/:id
 *
 * Metadata only — admin must redeem a support key (Step 18a) to see
 * a tenant's actual library data. These endpoints expose slug, name,
 * plan, status, subscription state, and counts only.
 */
@Controller('admin/tenants')
@UseGuards(AdminAuthGuard)
export class AdminTenantsController {
  @Get()
  async list(
    @Query('status') status?: string,
    @Query('planSlug') planSlug?: string,
    @Query('q') q?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.max(1, Math.min(200, Number(limitRaw) || 50));
    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (q && q.length) {
      where.OR = [
        { slug: { contains: q.toLowerCase() } },
        { name: { contains: q, mode: 'insensitive' } },
        { primaryEmail: { contains: q.toLowerCase() } },
      ];
    }
    if (planSlug) {
      where.subscription = { plan: { slug: planSlug } };
    }
    const rows = await controlDb.tenant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        slug: true,
        name: true,
        defaultLocale: true,
        status: true,
        primaryEmail: true,
        createdAt: true,
        cellId: true,
        subscription: {
          select: {
            status: true,
            billingMode: true,
            plan: { select: { slug: true, name: true } },
          },
        },
      },
    });
    return {
      tenants: rows.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        defaultLocale: t.defaultLocale,
        status: t.status,
        primaryEmail: t.primaryEmail,
        createdAt: t.createdAt,
        cellId: t.cellId,
        plan: t.subscription?.plan
          ? { slug: t.subscription.plan.slug, name: t.subscription.plan.name }
          : null,
        billingStatus: t.subscription?.status ?? null,
        billingMode: t.subscription?.billingMode ?? null,
      })),
    };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const tenant = await controlDb.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        slug: true,
        name: true,
        defaultLocale: true,
        status: true,
        primaryEmail: true,
        customSubdomain: true,
        cellId: true,
        dbUrl: true,
        storageUrl: true,
        createdAt: true,
        updatedAt: true,
        subscription: {
          include: { plan: true },
        },
        billingAccount: {
          select: {
            billingEmail: true,
            billingName: true,
            stripeCustomerId: true,
            country: true,
          },
        },
      },
    });
    if (!tenant) throw new NotFoundException('Tenant not found.');
    return { tenant };
  }
}
